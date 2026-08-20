/**
 * Prompt-cache benchmark — measures how much of each model request could be
 * served from a prefix/KV cache, for a deterministic multi-turn coding
 * trajectory driven through a real `AgentSession` (real system-prompt
 * construction, real tool registry, real tool execution, real append-only /
 * non-append-only request paths).
 *
 * Two configurations, identical in every other respect (each run gets its
 * own fresh temp working directory, so the cwd value differs per run at
 * equal length — it rides in the first user message):
 *
 *   legacy — `provider.appendOnlyContext: "off"`, the pre-change effective
 *            default for server-side prefix-cache providers (Anthropic,
 *            OpenAI, …): the request context is rebuilt fresh on every step.
 *   new    — `provider.appendOnlyContext: "auto"`, the current default, which
 *            resolves to append-only ON for every provider.
 *
 * Measurements (computed independently of the stability monitor, from the
 * exact contexts handed to the provider; the monitor's reports are
 * cross-checked against this accounting when available):
 *
 *   - serialized prompt length per request (system + tools + messages,
 *     canonical byte form)
 *   - reusable prefix length (LCP with the previous request)
 *   - percentage of prompt reusable from cache
 *   - unnecessary prefix invalidations (cause other than pure append)
 *   - full-prefix rebuilds
 *
 * No network, no real model: the model is a scripted mock (fixed assistant
 * responses) behind a registered custom API; tools execute against a throwaway
 * fixture repo in a temp dir.
 *
 * Run:
 *   bun scripts/prompt-cache-benchmark.ts            # human-readable report
 *   bun scripts/prompt-cache-benchmark.ts --json     # machine-readable JSON
 */
import * as fs from "node:fs/promises";

import { type AssistantMessage, type Context, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Canonical serialization — mirrors the stability monitor's canonical forms
// (system block JSON, fixed-field tool records, fixed-field message records,
// section order system → tools → messages) so the two agree byte-for-byte.
// Inlined (not imported) so this accounting is independent of the monitor
// implementation and can cross-check it.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
function byteLength(value: string): number {
	return enc.encode(value).length;
}

function canonicalSystemPrompt(systemPrompt: string[] | undefined): string {
	return JSON.stringify(systemPrompt ?? []);
}

function canonicalTools(tools: Context["tools"]): string {
	if (!tools || tools.length === 0) return "[]";
	return JSON.stringify(
		tools.map(t => ({
			n: t.name,
			d: t.description ?? "",
			p: t.parameters,
			s: t.strict ?? null,
			cf: t.customFormat ?? null,
			cw: t.customWireName ?? null,
		})),
	);
}

function canonicalMessage(message: unknown): string {
	if (!message || typeof message !== "object") {
		return JSON.stringify(message);
	}
	const m = message as Record<string, unknown>;
	return JSON.stringify({
		r: m.role ?? null,
		c: m.content ?? null,
		pp: m.providerPayload ?? null,
		tc: m.toolCalls ?? m.tool_calls ?? null,
		tcid: m.toolCallId ?? m.tool_call_id ?? null,
		tn: m.toolName ?? m.name ?? null,
		err: m.isError ?? null,
		id: m.id ?? null,
	});
}

interface SerializedRequest {
	system: string;
	tools: string;
	messages: string[];
	systemBytes: number;
	toolsBytes: number;
	messagesBytes: number;
	totalBytes: number;
	messageCount: number;
}

function serializeContext(context: Context): SerializedRequest {
	const system = canonicalSystemPrompt(context.systemPrompt);
	const tools = canonicalTools(context.tools);
	const messages = (context.messages ?? []).map(canonicalMessage);
	const systemBytes = byteLength(system);
	const toolsBytes = byteLength(tools);
	let messagesBytes = 0;
	for (const m of messages) messagesBytes += byteLength(m);
	return {
		system,
		tools,
		messages,
		systemBytes,
		toolsBytes,
		messagesBytes,
		totalBytes: systemBytes + toolsBytes + messagesBytes,
		messageCount: messages.length,
	};
}

type Divergence =
	| "first-request"
	| "appended"
	| "identical"
	| "system"
	| "tools"
	| `message[${number}]`
	| `shrank[${number}]`;

function compareRequests(prev: SerializedRequest | null, cur: SerializedRequest) {
	if (prev === null) {
		return {
			stablePrefixBytes: 0,
			divergence: "first-request" as Divergence,
			cause: ["first-request"],
		};
	}
	const cause: string[] = [];
	if (prev.system !== cur.system) {
		cause.push("system-prompt-changed");
		return { stablePrefixBytes: 0, divergence: "system" as Divergence, cause };
	}
	let stable = cur.systemBytes;
	if (prev.tools !== cur.tools) {
		cause.push("tool-set-changed");
		return { stablePrefixBytes: stable, divergence: "tools" as Divergence, cause };
	}
	stable += cur.toolsBytes;
	const bound = Math.min(cur.messages.length, prev.messages.length);
	for (let i = 0; i < bound; i++) {
		if (cur.messages[i] !== prev.messages[i]) {
			cause.push(`message[${i}]-rewritten`);
			return { stablePrefixBytes: stable, divergence: `message[${i}]` as Divergence, cause };
		}
		stable += byteLength(cur.messages[i]!);
	}
	if (cur.messages.length < prev.messages.length) {
		cause.push("history-shrank");
		return { stablePrefixBytes: stable, divergence: `shrank[${cur.messages.length}]` as Divergence, cause };
	}
	if (cur.messages.length > prev.messages.length) {
		return { stablePrefixBytes: stable, divergence: "appended" as Divergence, cause: ["appended"] };
	}
	return { stablePrefixBytes: stable, divergence: "identical" as Divergence, cause: ["identical-request"] };
}

// ---------------------------------------------------------------------------
// Fixture + scripted trajectory
// ---------------------------------------------------------------------------

const FIXTURE_COUNTER = `export function sumTo(n: number): number {
	let total = 0;
	for (let i = 1; i < n; i++) {
		total += i;
	}
	return total;
}
`;

const FIX_COUNTER = `export function sumTo(n: number): number {
	let total = 0;
	for (let i = 0; i <= n; i++) {
		total += i;
	}
	return total;
}
`;

const FIXTURE_TEST = `import { expect, test } from "bun:test";
import { sumTo } from "../src/counter";

test("sumTo sums 0..n inclusive", () => {
	expect(sumTo(0)).toBe(0);
	expect(sumTo(1)).toBe(1);
	expect(sumTo(4)).toBe(10);
});
`;

/** Scripted assistant responses, in model-call order (3 user turns, 6 calls). */
const SCRIPTED_RESPONSES: Array<{
	text?: string;
	toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}> = [
	{ toolCall: { id: "c1", name: "read", arguments: { path: "src/counter.ts" } } },
	{ toolCall: { id: "c2", name: "write", arguments: { path: "src/counter.ts", content: FIX_COUNTER } } },
	{ text: "Fixed the off-by-one in sumTo: the loop now covers 0..n inclusive." },
	{ toolCall: { id: "c3", name: "write", arguments: { path: "test/counter.test.ts", content: FIXTURE_TEST } } },
	{ text: "Added test/counter.test.ts with boundary cases n=0, n=1, and n=4." },
	{ text: "Two changes: fixed sumTo's off-by-one bug and added boundary tests for it." },
];

const TURNS: Array<{ user: string; calls: number }> = [
	{ user: "There is an off-by-one bug in src/counter.ts. Find it and fix it.", calls: 3 },
	{ user: "Add a unit test for the counter module.", calls: 2 },
	{ user: "Summarize the changes made this session.", calls: 1 },
];

function makeAssistantMessage(
	spec: (typeof SCRIPTED_RESPONSES)[number],
	api: string,
	provider: string,
	modelId: string,
): AssistantMessage {
	const content: AssistantMessage["content"] = spec.toolCall
		? [{ type: "toolCall", id: spec.toolCall.id, name: spec.toolCall.name, arguments: spec.toolCall.arguments }]
		: [{ type: "text", text: spec.text ?? "" }];
	return {
		role: "assistant",
		content,
		api,
		provider,
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: spec.toolCall ? "toolUse" : "stop",
		timestamp: 0,
	};
}

// ---------------------------------------------------------------------------
// One benchmark configuration
// ---------------------------------------------------------------------------

interface RequestMetrics {
	index: number;
	turn: number;
	totalBytes: number;
	systemBytes: number;
	toolsBytes: number;
	messagesBytes: number;
	messageCount: number;
	stablePrefixBytes: number;
	reuseRatio: number;
	firstDivergence: Divergence;
	cause: string[];
	prefixRebuilt: boolean;
}

interface ConfigResult {
	label: string;
	setting: string;
	appendOnlyActive: boolean;
	toolCount: number;
	toolNames: string[];
	requests: RequestMetrics[];
	turns: Array<{
		turn: number;
		user: string;
		modelCalls: number;
		lastTotalBytes: number;
		lastReuseRatio: number;
	}>;
	summary: {
		requests: number;
		avgReuseRatio: number; // requests 2+
		fullRebuilds: number;
		invalidations: number; // non-pure-append requests (2+)
		causeBreakdown: Record<string, number>;
		totalPromptBytes: number; // sum over all requests
		cacheServableBytes: number; // sum of stable-prefix bytes (2+)
		overallReuseRatio: number;
		monitorCrossCheck: "matched" | "mismatch" | "unavailable";
	};
}

async function runConfiguration(label: string, setting: "off" | "auto", api: string): Promise<ConfigResult> {
	// One shared prefix (mkdtemp appends a fixed-length random suffix) so both
	// configurations produce equal-length temp paths: the cwd rides in the
	// first user message and must not skew the cross-configuration byte totals.
	const tempDir = TempDir.createSync("prompt-cache-bench-");
	try {
		await fs.mkdir(tempDir.join("src"), { recursive: true });
		await fs.writeFile(tempDir.join("src/counter.ts"), FIXTURE_COUNTER);
		await fs.writeFile(tempDir.join("README.md"), "# bench fixture\n");

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "bench-test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = buildModel({
			id: "claude-bench",
			name: "Bench Model",
			api,
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} as never) as never;

		const contexts: Context[] = [];
		let callIndex = 0;
		registerCustomApi(api, (_m, context: Context) => {
			contexts.push(context);
			const spec = SCRIPTED_RESPONSES[callIndex++];
			if (!spec) throw new Error(`Scripted response exhausted at model call ${callIndex}`);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = makeAssistantMessage(spec, api, "anthropic", "claude-bench");
				for (const block of message.content) {
					if (block.type === "text") {
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
					} else if (block.type === "toolCall") {
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: JSON.stringify(block.arguments),
							partial: message,
						});
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
					}
				}
				stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			});
			return stream;
		});

		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"provider.appendOnlyContext": setting,
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "Bench",
		});
		try {
			for (const turn of TURNS) {
				await session.sendUserMessage(turn.user);
			}

			// Independent per-request accounting from the captured contexts.
			const serialized = contexts.map(serializeContext);
			const turnEnds: number[] = [];
			for (const t of TURNS) turnEnds.push((turnEnds[turnEnds.length - 1] ?? 0) + t.calls);
			const requests: RequestMetrics[] = [];
			const turns: ConfigResult["turns"] = [];
			let prev: SerializedRequest | null = null;
			for (let i = 0; i < serialized.length; i++) {
				const s = serialized[i]!;
				const cmp = compareRequests(prev, s);
				const turnNo = turnEnds.findIndex(end => i < end) + 1;
				const metrics: RequestMetrics = {
					index: i + 1,
					turn: turnNo,
					totalBytes: s.totalBytes,
					systemBytes: s.systemBytes,
					toolsBytes: s.toolsBytes,
					messagesBytes: s.messagesBytes,
					messageCount: s.messageCount,
					stablePrefixBytes: cmp.stablePrefixBytes,
					reuseRatio: s.totalBytes > 0 ? cmp.stablePrefixBytes / s.totalBytes : 0,
					firstDivergence: cmp.divergence,
					cause: cmp.cause,
					prefixRebuilt: cmp.stablePrefixBytes === 0 && i > 0,
				};
				requests.push(metrics);
				if (i === turnEnds[turnNo - 1]! - 1) {
					turns.push({
						turn: turnNo,
						user: TURNS[turnNo - 1]!.user,
						modelCalls: TURNS[turnNo - 1]!.calls,
						lastTotalBytes: s.totalBytes,
						lastReuseRatio: metrics.reuseRatio,
					});
				}
				prev = s;
			}

			// Cross-check against the stability monitor, when the tree has one.
			let monitorCrossCheck: ConfigResult["summary"]["monitorCrossCheck"] = "unavailable";
			const monitor = (
				session.agent as unknown as {
					stabilityMonitor?: { history?: () => Array<Record<string, unknown>> };
				}
			).stabilityMonitor;
			const reports = monitor?.history?.();
			if (reports && reports.length === requests.length) {
				let matched = true;
				for (const [i, r] of reports.entries()) {
					const m = requests[i]!;
					const expectedDivergence =
						i === 0
							? "none"
							: m.firstDivergence === "identical"
								? "none"
								: m.firstDivergence.startsWith("shrank")
									? `message[${m.messageCount}]`
									: m.firstDivergence;
					if (
						Number(r.totalBytes) !== m.totalBytes ||
						Number(r.stablePrefixBytes) !== m.stablePrefixBytes ||
						String(r.firstDivergence) !== expectedDivergence
					) {
						matched = false;
						break;
					}
				}
				monitorCrossCheck = matched ? "matched" : "mismatch";
			}

			const fromSecond = requests.slice(1);
			const totalPromptBytes = requests.reduce((a, r) => a + r.totalBytes, 0);
			const cacheServableBytes = fromSecond.reduce((a, r) => a + r.stablePrefixBytes, 0);
			const causeBreakdown: Record<string, number> = {};
			for (const r of fromSecond) for (const c of r.cause) causeBreakdown[c] = (causeBreakdown[c] ?? 0) + 1;

			return {
				label,
				setting,
				appendOnlyActive: (session.agent as { appendOnlyContext?: unknown }).appendOnlyContext != null,
				toolCount: contexts[0]?.tools?.length ?? 0,
				toolNames: contexts[0]?.tools?.map(t => t.name) ?? [],
				requests,
				turns,
				summary: {
					requests: requests.length,
					avgReuseRatio:
						fromSecond.length > 0 ? fromSecond.reduce((a, r) => a + r.reuseRatio, 0) / fromSecond.length : 0,
					fullRebuilds: fromSecond.filter(r => r.prefixRebuilt).length,
					invalidations: fromSecond.filter(r => r.cause.some(c => c !== "appended")).length,
					causeBreakdown,
					totalPromptBytes,
					cacheServableBytes,
					overallReuseRatio: totalPromptBytes > 0 ? cacheServableBytes / totalPromptBytes : 0,
					monitorCrossCheck,
				},
			};
		} finally {
			await session.dispose?.();
		}
	} finally {
		await tempDir.remove();
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pct(x: number): string {
	return `${(x * 100).toFixed(1)}%`;
}

function kb(x: number): string {
	return x >= 1024 ? `${(x / 1024).toFixed(1)}KB` : `${x}B`;
}

function printReport(legacy: ConfigResult, fresh: ConfigResult): void {
	console.log("Prompt-cache benchmark");
	console.log(`model anthropic/claude-bench · ${TURNS.length} turns · ${SCRIPTED_RESPONSES.length} model calls`);
	console.log(
		`tools: ${fresh.toolCount} (${fresh.toolNames.slice(0, 6).join(", ")}${fresh.toolCount > 6 ? ", …" : ""})\n`,
	);
	for (const cfg of [legacy, fresh]) {
		const note =
			cfg.setting === "off"
				? "pre-change default for server-side cache providers"
				: "current default (auto → append-only ON)";
		console.log(`Configuration: ${cfg.label} — provider.appendOnlyContext=${cfg.setting} (${note})`);
		console.log(`append-only active: ${cfg.appendOnlyActive ? "yes" : "no"}\n`);
		console.log("  req  turn  total  stable-prefix  reuse   divergence       cause");
		for (const r of cfg.requests) {
			const stable = r.index === 1 ? "baseline".padEnd(9) : `${kb(r.stablePrefixBytes)}`.padEnd(9);
			const reuse = r.index === 1 ? "—".padEnd(5) : pct(r.reuseRatio).padEnd(5);
			console.log(
				`  ${String(r.index).padStart(3)}  T${r.turn}   ${kb(r.totalBytes).padStart(6)}  ${stable}  ${reuse}  ${r.firstDivergence.padEnd(16)}  ${r.cause.join(", ")}`,
			);
		}
		console.log("\n  per turn (final request of the turn):");
		for (const t of cfg.turns) {
			console.log(
				`    T${t.turn}: ${t.modelCalls} model calls · prompt ${kb(t.lastTotalBytes)} · ${pct(t.lastReuseRatio)} of that request cache-reusable`,
			);
		}
		const s = cfg.summary;
		console.log("\n  summary:");
		console.log(`    requests: ${s.requests}`);
		console.log(`    avg reuse (req 2+): ${pct(s.avgReuseRatio)}`);
		console.log(`    full-prefix rebuilds: ${s.fullRebuilds}`);
		console.log(`    prefix invalidations (non-append): ${s.invalidations}`);
		console.log(`    cause breakdown: ${JSON.stringify(s.causeBreakdown)}`);
		console.log(`    total prompt bytes (sum over requests): ${s.totalPromptBytes}`);
		console.log(
			`    bytes a KV-retaining engine could skip re-prefilling: ${s.cacheServableBytes} (${pct(s.overallReuseRatio)} of total)`,
		);
		console.log(`    stability-monitor cross-check: ${s.monitorCrossCheck}\n`);
	}
	console.log("Δ (new − legacy):");
	console.log(`  avg reuse: ${pct(fresh.summary.avgReuseRatio)} vs ${pct(legacy.summary.avgReuseRatio)}`);
	console.log(
		`  invalidations: ${fresh.summary.invalidations} vs ${legacy.summary.invalidations} · full rebuilds: ${fresh.summary.fullRebuilds} vs ${legacy.summary.fullRebuilds}`,
	);
}

async function main(): Promise<void> {
	const asJson = process.argv.includes("--json");
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const legacy = await runConfiguration("legacy", "off", "bench-legacy-api");
	const fresh = await runConfiguration("new", "auto", "bench-new-api");
	if (asJson) {
		console.log(JSON.stringify({ legacy, fresh }, null, 2));
	} else {
		printReport(legacy, fresh);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
