/**
 * Prompt-stability monitor — measures, for every provider-bound request, how
 * much of the serialized prompt was already established by the previous
 * request of the same agent.
 *
 * Why this exists (prompt-cache stability):
 *
 * Prefix/KV caches (provider-side on Anthropic/OpenAI/DeepSeek, llama.cpp-style
 * prefix reuse on local engines) are byte-sensitive: the cache is valid up to
 * the first byte that differs between consecutive requests. OMP's whole request
 * construction is designed to keep that divergence point as far back as
 * possible (frozen system prompt, deterministic tool serialization, append-only
 * message log, per-request volatility at the tail). This monitor makes that
 * design *measurable* instead of assumed, and answers "why did this request
 * lose its prompt-cache hit?" with a deterministic, provider-agnostic report:
 *
 * - total serialized prompt size (bytes, UTF-8)
 * - stable prefix size between consecutive requests
 * - first changed section / message boundary
 * - which component caused the invalidation (system prompt, tool set, message
 *   rewrite, history shrink/compaction, model switch)
 * - estimated cache-hit ratio from the serialized request, upgraded to an
 *   actual ratio when the provider reports `cacheRead`/`cacheWrite` usage
 *
 * Correctness never depends on caching: the monitor is pure observation. When
 * no provider-side cache exists, the same numbers describe how much re-prefill
 * a KV-retaining local engine would still have to do.
 *
 * Cost model: each recorded request canonicalizes its context with one
 * `JSON.stringify` per message — the same order of work the provider layer
 * performs to serialize the request for the wire. No cross-request caching of
 * message bytes is attempted because message objects can be mutated in place
 * (that is exactly what `AppendOnlyContextManager`'s digests detect), and an
 * identity-keyed cache would silently report stale bytes.
 */

import type { Context, Message } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Canonical byte form of a section. Canonical forms are compared by string
 * equality and lengthed in UTF-8 bytes; they are intentionally NOT provider
 * wire formats (those differ per API) but a provider-agnostic serialization
 * over exactly the fields every provider would serialize.
 */

/** Canonical form of the system prompt: the block array, JSON-serialized. */
export function canonicalSystemPrompt(systemPrompt: string[] | undefined): string {
	return JSON.stringify(systemPrompt ?? []);
}

/**
 * Canonical form of the tool array. Field order is fixed; `parameters` keeps
 * its stable key insertion order (wire schemas are memoized pure functions of
 * the tool definition, so logically identical tools serialize identically
 * across rebuilds).
 */
export function canonicalTools(tools: Context["tools"]): string {
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

/**
 * Canonical form of one provider-level message. The field set mirrors
 * `AppendOnlyContextManager.#messageDigest` (role, content, provider-native
 * replay payload, both tool-call spellings, both tool-result id/name spellings,
 * error flag, assistant id) so the monitor and the append-only sync disagree
 * on nothing.
 */
export function canonicalMessage(message: unknown): string {
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

/** UTF-8 byte length of a string. */
export function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Where the current request first diverges from the previous one. */
export type FirstDivergence =
	| "none" // first request, or byte-identical to the previous one (e.g. retry)
	| "appended" // strict extension: previous request is a full byte-prefix
	| "system"
	| "tools"
	| `message[${number}]`;

/**
 * One recorded provider request and its relationship to the previous request
 * of the same agent. Values are deterministic for a deterministic request
 * sequence, which is what makes them assertable in tests.
 */
export interface PromptStabilityReport {
	/** 1-based index of this request within the agent's recorded lifetime. */
	requestIndex: number;
	modelId: string;
	providerId: string;
	/** Whether the request went through the append-only context manager. */
	appendOnly: boolean;
	/** Total serialized prompt size in UTF-8 bytes (system + tools + messages). */
	totalBytes: number;
	systemBytes: number;
	toolsBytes: number;
	messagesBytes: number;
	/** Bytes shared, in order, with the previous request (0 for the first). */
	stablePrefixBytes: number;
	/** stablePrefixBytes / totalBytes — the deterministic local estimate of
	 * the fraction of this prompt a prefix-aware backend could serve from
	 * cache. 0 for the first request (nothing to reuse yet). */
	estimatedCacheHitRatio: number;
	/**
	 * Actual cached fraction from provider-reported usage, when available:
	 * cacheRead / (input + cacheRead + cacheWrite). Undefined when the
	 * provider reports no cache statistics.
	 */
	actualCacheHitRatio: number | undefined;
	cacheReadTokens: number | undefined;
	cacheWriteTokens: number | undefined;
	firstDivergence: FirstDivergence;
	systemChanged: boolean;
	toolsChanged: boolean;
	toolNamesAdded: string[];
	toolNamesRemoved: string[];
	messageCount: number;
	/** True when the message list shrank vs the previous request (compaction,
	 * reset, or rollback) — always a full prefix rebuild from the divergence. */
	messagesShrank: boolean;
	modelChanged: boolean;
	/** True when the stable prefix is 0 (full rebuild). */
	prefixRebuilt: boolean;
	/**
	 * Attribution of the prefix invalidation, most significant first.
	 * Always non-empty; examples: "appended", "system-prompt-changed",
	 * "tool-set-changed", "message[3]-rewritten", "compaction", "model-switch".
	 */
	cause: string[];
	/** Session-level events noted since the previous request (e.g. compaction). */
	events: string[];
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

interface RecordedRequest {
	modelId: string;
	providerId: string;
	appendOnly: boolean;
	system: string;
	tools: string;
	messages: string[];
	toolNames: string[];
	systemBytes: number;
	toolsBytes: number;
	messagesBytes: number;
	totalBytes: number;
	/** References to the recorded context sections (NOT copies) so the host
	 * can rebuild a KV-aligned compaction request from exactly what was last
	 * on the wire. */
	systemPrompt: string[] | undefined;
	toolsRef: Context["tools"];
	messagesRef: Message[];
}

/** Cap on retained per-request reports (memory is trivial; tests assert on
 * the last few, dumps show the current run). */
const MAX_HISTORY = 512;

export class PromptStabilityMonitor {
	#last: RecordedRequest | null = null;
	#requestIndex = 0;
	#reports: PromptStabilityReport[] = [];
	#pendingEvents: string[] = [];

	get requestCount(): number {
		return this.#requestIndex;
	}

	/** Note a session-level event (e.g. "compaction") so the next recorded
	 * request can attribute the prefix change to it. Events are consumed by
	 * the next `recordRequest`. */
	noteEvent(label: string): void {
		this.#pendingEvents.push(label);
	}

	/**
	 * Record a provider-bound request. Must be called with the FINAL context
	 * that is about to be serialized for the provider (after all
	 * transforms), once per request, in request order.
	 */
	recordRequest(
		context: Context,
		model: { id: string; provider: string },
		meta?: { appendOnly?: boolean },
	): PromptStabilityReport {
		const systemPrompt = context.systemPrompt;
		const tools = context.tools;
		const messages = context.messages ?? [];

		const system = canonicalSystemPrompt(systemPrompt);
		const toolList = tools ?? [];
		const toolCanonical = canonicalTools(toolList);
		const toolNames = toolList.map(t => t.name);
		const messageCanonicals: string[] = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			messageCanonicals[i] = canonicalMessage(messages[i] as unknown);
		}

		const systemBytes = byteLength(system);
		const toolsBytes = byteLength(toolCanonical);
		let messagesBytes = 0;
		for (let i = 0; i < messageCanonicals.length; i++) {
			messagesBytes += byteLength(messageCanonicals[i]!);
		}
		const totalBytes = systemBytes + toolsBytes + messagesBytes;

		const prev = this.#last;
		const appendOnly = meta?.appendOnly === true;
		const modelChanged = prev !== null && (prev.modelId !== model.id || prev.providerId !== model.provider);

		let stablePrefixBytes = 0;
		let firstDivergence: FirstDivergence = prev ? "appended" : "none";
		let systemChanged = false;
		let toolsChanged = false;
		let messagesShrank = false;

		if (prev) {
			if (system !== prev.system) {
				firstDivergence = "system";
				systemChanged = true;
			} else if (toolCanonical !== prev.tools) {
				firstDivergence = "tools";
				toolsChanged = true;
				stablePrefixBytes = systemBytes;
			} else {
				stablePrefixBytes = systemBytes + toolsBytes;
				const bound = Math.min(messageCanonicals.length, prev.messages.length);
				for (let i = 0; i < bound; i++) {
					if (messageCanonicals[i] !== prev.messages[i]) {
						firstDivergence = `message[${i}]`;
						break;
					}
					stablePrefixBytes += byteLength(messageCanonicals[i]!);
				}
				messagesShrank = messageCanonicals.length < prev.messages.length;
				if (messageCanonicals.length === prev.messages.length && firstDivergence === "appended") {
					// Same count, no divergence: byte-identical request (retry).
					firstDivergence = "none";
				}
			}
		} else {
			firstDivergence = "none";
		}

		const toolNamesAdded = toolNames.filter(name => !prev?.toolNames.includes(name));
		const toolNamesRemoved = prev ? prev.toolNames.filter(name => !toolNames.includes(name)) : [];

		const cause: string[] = [];
		if (modelChanged) cause.push("model-switch");
		if (systemChanged) cause.push("system-prompt-changed");
		if (toolsChanged) cause.push("tool-set-changed");
		if (messagesShrank) cause.push("history-shrank");
		if (typeof firstDivergence === "string" && firstDivergence.startsWith("message[")) {
			cause.push(`${firstDivergence}-rewritten`);
		}
		if (cause.length === 0) {
			cause.push(
				prev === null ? "first-request" : firstDivergence === "appended" ? "appended" : "identical-request",
			);
		}

		const events = this.#pendingEvents.splice(0, this.#pendingEvents.length);
		if (events.length > 0) cause.push(...events);

		this.#requestIndex++;
		const report: PromptStabilityReport = {
			requestIndex: this.#requestIndex,
			modelId: model.id,
			providerId: model.provider,
			appendOnly,
			totalBytes,
			systemBytes,
			toolsBytes,
			messagesBytes,
			stablePrefixBytes,
			estimatedCacheHitRatio: totalBytes > 0 ? stablePrefixBytes / totalBytes : 0,
			actualCacheHitRatio: undefined,
			cacheReadTokens: undefined,
			cacheWriteTokens: undefined,
			firstDivergence,
			systemChanged,
			toolsChanged,
			toolNamesAdded,
			toolNamesRemoved,
			messageCount: messages.length,
			messagesShrank,
			modelChanged,
			prefixRebuilt: stablePrefixBytes === 0,
			cause,
			events,
		};
		this.#reports.push(report);
		if (this.#reports.length > MAX_HISTORY) this.#reports.splice(0, this.#reports.length - MAX_HISTORY);

		this.#last = {
			modelId: model.id,
			providerId: model.provider,
			appendOnly,
			system,
			tools: toolCanonical,
			messages: messageCanonicals,
			toolNames,
			systemBytes,
			toolsBytes,
			messagesBytes,
			totalBytes,
			systemPrompt,
			toolsRef: toolList,
			messagesRef: messages,
		};
		logger.debug("prompt-stability", {
			request: report.requestIndex,
			model: model.id,
			appendOnly,
			totalBytes,
			stablePrefixBytes,
			estimatedCacheHitRatio: Math.round(report.estimatedCacheHitRatio * 10000) / 10000,
			firstDivergence,
			cause,
			systemChanged,
			toolsChanged,
			messagesShrank,
			messageCount: messages.length,
		});

		return report;
	}

	/**
	 * Attach provider-reported usage to the most recent recorded request.
	 * When the provider reports cache statistics, the report's
	 * `actualCacheHitRatio` becomes the provider's own measurement of how
	 * much of this prompt it served from cache.
	 */
	recordUsage(usage: { input?: number; cacheRead?: number; cacheWrite?: number } | undefined): void {
		const report = this.#reports[this.#reports.length - 1];
		if (!report || !usage) return;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		if (cacheRead === 0 && cacheWrite === 0) return;
		report.cacheReadTokens = cacheRead || undefined;
		report.cacheWriteTokens = cacheWrite || undefined;
		const totalInput = (usage.input ?? 0) + cacheRead + cacheWrite;
		report.actualCacheHitRatio = totalInput > 0 ? cacheRead / totalInput : undefined;
	}

	/** The most recent report (post-usage if `recordUsage` has run). */
	last(): PromptStabilityReport | undefined {
		return this.#reports[this.#reports.length - 1];
	}

	/** The last `n` reports (default: all retained). Oldest first. */
	history(n?: number): PromptStabilityReport[] {
		return n === undefined ? [...this.#reports] : this.#reports.slice(-n);
	}

	/**
	 * The final context sections of the most recent recorded request, by
	 * reference. Used to build a KV-aligned compaction request: the compaction
	 * summarization replays exactly the system prompt + tools that were last
	 * on the wire, plus the verbatim shadowed region, so it becomes a prefix
	 * extension of the last live request. `messages` is the recorded message
	 * array itself (references, not copies) — a host-side replay of the
	 * shadowed region is validated against it and, when byte-aligned, the
	 * recorded wire bytes are adopted verbatim. Returns undefined before the
	 * first recorded request.
	 */
	lastLiveContext():
		| {
				systemPrompt: string[];
				tools: Context["tools"];
				messages: Message[];
		  }
		| undefined {
		const last = this.#last;
		if (!last?.systemPrompt || last.systemPrompt.length === 0) return undefined;
		return { systemPrompt: last.systemPrompt, tools: last.toolsRef ?? [], messages: last.messagesRef };
	}

	/** Drop all recorded state (new session / model reset). */
	reset(): void {
		this.#last = null;
		this.#requestIndex = 0;
		this.#reports = [];
		this.#pendingEvents = [];
	}
}
