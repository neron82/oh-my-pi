import { describe, expect, test } from "bun:test";
import type { Context, Message, Tool } from "@oh-my-pi/pi-ai";
import {
	byteLength,
	canonicalMessage,
	canonicalSystemPrompt,
	canonicalTools,
	PromptStabilityMonitor,
} from "../src/prompt-stability";

const modelA = { id: "mock-model", provider: "mock" };
const modelB = { id: "other-model", provider: "mock" };

function userMessage(text: string): Message {
	return { role: "user", content: text } as Message;
}

function tool(name: string, description = "a tool"): Tool {
	return {
		name,
		description,
		parameters: { type: "object", properties: { arg: { type: "string" } } },
	} as Tool;
}

function makeContext(messages: Message[], tools?: Tool[], systemPrompt?: string[]): Context {
	return { systemPrompt: systemPrompt ?? ["sys"], tools, messages };
}

describe("PromptStabilityMonitor", () => {
	test("first request records the full prompt with nothing to reuse", () => {
		const monitor = new PromptStabilityMonitor();
		const report = monitor.recordRequest(makeContext([userMessage("a")], [tool("t")]), modelA);

		expect(report.requestIndex).toBe(1);
		expect(report.firstDivergence).toBe("none");
		expect(report.stablePrefixBytes).toBe(0);
		expect(report.estimatedCacheHitRatio).toBe(0);
		expect(report.prefixRebuilt).toBe(true);
		expect(report.totalBytes).toBe(report.systemBytes + report.toolsBytes + report.messagesBytes);
		expect(report.totalBytes).toBeGreaterThan(0);
		expect(report.cause).toEqual(["first-request"]);
	});

	test("byte-identical second request reuses the whole prefix", () => {
		const monitor = new PromptStabilityMonitor();
		const context = makeContext([userMessage("a")], [tool("t")]);
		const first = monitor.recordRequest(context, modelA);
		const second = monitor.recordRequest(context, modelA);

		expect(second.firstDivergence).toBe("none");
		expect(second.cause).toEqual(["identical-request"]);
		expect(second.stablePrefixBytes).toBe(first.totalBytes);
		expect(second.estimatedCacheHitRatio).toBe(1);
		expect(second.prefixRebuilt).toBe(false);
	});

	test("append-only growth keeps the entire previous request as a stable prefix", () => {
		const monitor = new PromptStabilityMonitor();
		const first = monitor.recordRequest(makeContext([userMessage("a")], [tool("t")]), modelA);
		const second = monitor.recordRequest(
			makeContext([userMessage("a"), userMessage("b")], [tool("t")]),
			modelA,
		);

		expect(second.firstDivergence).toBe("appended");
		expect(second.cause).toEqual(["appended"]);
		expect(second.stablePrefixBytes).toBe(first.totalBytes);
		expect(second.estimatedCacheHitRatio).toBeCloseTo(first.totalBytes / second.totalBytes);
	});

	test("tool-set change invalidates from the tool boundary and reports added/removed names", () => {
		const monitor = new PromptStabilityMonitor();
		const first = monitor.recordRequest(makeContext([userMessage("a")], [tool("t"), tool("u")]), modelA);
		const second = monitor.recordRequest(makeContext([userMessage("a")], [tool("t"), tool("v")]), modelA);

		expect(second.firstDivergence).toBe("tools");
		expect(second.toolsChanged).toBe(true);
		expect(second.stablePrefixBytes).toBe(first.systemBytes);
		expect(second.toolNamesAdded).toEqual(["v"]);
		expect(second.toolNamesRemoved).toEqual(["u"]);
		expect(second.cause).toContain("tool-set-changed");
	});

	test("system prompt change invalidates from byte zero", () => {
		const monitor = new PromptStabilityMonitor();
		const first = monitor.recordRequest(makeContext([userMessage("a")], undefined, ["sys"]), modelA);
		const second = monitor.recordRequest(makeContext([userMessage("a")], undefined, ["sys-changed"]), modelA);

		expect(second.firstDivergence).toBe("system");
		expect(second.systemChanged).toBe(true);
		expect(second.stablePrefixBytes).toBe(0);
		expect(second.prefixRebuilt).toBe(true);
		expect(second.cause).toContain("system-prompt-changed");
		expect(first.totalBytes).toBeGreaterThan(0);
	});

	test("rewritten middle message diverges exactly at its index", () => {
		const monitor = new PromptStabilityMonitor();
		const first = monitor.recordRequest(
			makeContext([userMessage("a"), userMessage("b"), userMessage("c")]),
			modelA,
		);
		const second = monitor.recordRequest(
			makeContext([userMessage("a"), userMessage("B"), userMessage("c")]),
			modelA,
		);

		expect(second.firstDivergence).toBe("message[1]");
		expect(second.cause).toContain("message[1]-rewritten");
		// Stable prefix: system + tools + first message only.
		expect(second.stablePrefixBytes).toBe(
			first.systemBytes + first.toolsBytes + byteLength(canonicalMessage(userMessage("a"))),
		);
	});

	test("shrunken history keeps the shared prefix but is flagged as a shrink", () => {
		const monitor = new PromptStabilityMonitor();
		monitor.recordRequest(makeContext([userMessage("a"), userMessage("b"), userMessage("c")]), modelA);
		const second = monitor.recordRequest(makeContext([userMessage("a")]), modelA);

		expect(second.messagesShrank).toBe(true);
		expect(second.cause).toContain("history-shrank");
		expect(second.firstDivergence).toBe("appended");
	});

	test("model switch is attributed even when content is identical", () => {
		const monitor = new PromptStabilityMonitor();
		const context = makeContext([userMessage("a")]);
		monitor.recordRequest(context, modelA);
		const second = monitor.recordRequest(context, modelB);

		expect(second.modelChanged).toBe(true);
		expect(second.cause).toContain("model-switch");
	});

	test("noteEvent is consumed by the next recorded request only", () => {
		const monitor = new PromptStabilityMonitor();
		monitor.recordRequest(makeContext([userMessage("a")]), modelA);
		monitor.noteEvent("compaction");
		const withEvent = monitor.recordRequest(makeContext([userMessage("a"), userMessage("b")]), modelA);
		const without = monitor.recordRequest(makeContext([userMessage("a"), userMessage("b"), userMessage("c")]), modelA);

		expect(withEvent.events).toEqual(["compaction"]);
		expect(withEvent.cause).toContain("compaction");
		expect(without.events).toEqual([]);
		expect(without.cause).not.toContain("compaction");
	});

	test("recordUsage attaches provider cache statistics to the latest report", () => {
		const monitor = new PromptStabilityMonitor();
		monitor.recordRequest(makeContext([userMessage("a")]), modelA);
		monitor.recordUsage({ input: 2, cacheRead: 8, cacheWrite: 0 });

		const report = monitor.last();
		expect(report?.cacheReadTokens).toBe(8);
		expect(report?.actualCacheHitRatio).toBeCloseTo(8 / 10);
	});

	test("recordUsage without cache statistics leaves the report untouched", () => {
		const monitor = new PromptStabilityMonitor();
		monitor.recordRequest(makeContext([userMessage("a")]), modelA);
		monitor.recordUsage({ input: 100 });

		const report = monitor.last();
		expect(report?.actualCacheHitRatio).toBeUndefined();
		expect(report?.cacheReadTokens).toBeUndefined();
	});

	test("lastLiveContext returns references to the recorded sections", () => {
		const monitor = new PromptStabilityMonitor();
		expect(monitor.lastLiveContext()).toBeUndefined();

		const systemPrompt = ["live-system"];
		const tools = [tool("t")];
		const messages = [userMessage("a"), userMessage("b")];
		monitor.recordRequest({ systemPrompt, tools, messages } as Context, modelA);

		const live = monitor.lastLiveContext();
		expect(live?.systemPrompt).toBe(systemPrompt);
		expect(live?.tools).toBe(tools);
		expect(live?.messages).toBe(messages);
	});

	test("reset clears recorded state", () => {
		const monitor = new PromptStabilityMonitor();
		monitor.recordRequest(makeContext([userMessage("a")]), modelA);
		monitor.reset();

		expect(monitor.requestCount).toBe(0);
		expect(monitor.lastLiveContext()).toBeUndefined();
		const second = monitor.recordRequest(makeContext([userMessage("a")]), modelA);
		expect(second.requestIndex).toBe(1);
		expect(second.firstDivergence).toBe("none");
	});
});

describe("canonical serialization", () => {
	test("system prompt canonical form is deterministic and sensitive", () => {
		expect(canonicalSystemPrompt(["a", "b"])).toBe(canonicalSystemPrompt(["a", "b"]));
		expect(canonicalSystemPrompt(["a", "b"])).not.toBe(canonicalSystemPrompt(["a", "c"]));
		expect(canonicalSystemPrompt(undefined)).toBe("[]");
	});

	test("tools canonical form is deterministic and covers the wire-relevant fields", () => {
		expect(canonicalTools([tool("t")])).toBe(canonicalTools([tool("t")]));
		expect(canonicalTools([tool("t")])).not.toBe(canonicalTools([tool("t", "other")]));
		expect(canonicalTools(undefined)).toBe("[]");
		expect(canonicalTools([])).toBe("[]");
	});

	test("message canonical form ignores irrelevant fields and keeps the wire-relevant ones", () => {
		const base = { role: "user", content: "hi" };
		expect(canonicalMessage(base)).toBe(canonicalMessage({ ...base, someLocalField: "ignored" }));
		expect(canonicalMessage(base)).not.toBe(canonicalMessage({ role: "user", content: "bye" }));
	});
});
