/**
 * Prompt-stability contract across real agent turns: consecutive requests of
 * the same agent must share an identical stable prefix (system + tools +
 * established messages), with new state entering only as appended events.
 * These tests drive the real Agent loop (mock provider) and assert on the
 * per-request reports the stability monitor records inside
 * `prepareProviderCall` — the same accounting surfaced in `/dump` and OTEL.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";

describe("Agent prompt stability across consecutive turns", () => {
	it("keeps an identical stable prefix for two consecutive turns with unchanged configuration", async () => {
		const mock = createMockModel({
			responses: [{ content: ["answer one"] }, { content: ["answer two"] }],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["You are a test assistant."],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		await agent.prompt("first question");
		const first = agent.stabilityMonitor.last();
		expect(first?.requestIndex).toBe(1);
		expect(first?.prefixRebuilt).toBe(true);

		await agent.prompt("second question");
		const second = agent.stabilityMonitor.last();

		expect(second?.requestIndex).toBe(2);
		expect(second?.firstDivergence).toBe("appended");
		expect(second?.systemChanged).toBe(false);
		expect(second?.toolsChanged).toBe(false);
		expect(second?.modelChanged).toBe(false);
		// The entire first request is still a byte-prefix of the second.
		expect(second?.stablePrefixBytes).toBe(first?.totalBytes);
		expect(second?.cause).toEqual(["appended"]);
	});

	it("appends tool calls and results as new events without rewriting earlier context", async () => {
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echoes a value",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echo:${params.value}` }], details: { value: params.value } };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["You are a test assistant."],
				tools: [tool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		await agent.prompt("echo something");

		// Two model calls in one turn: the initial call and the post-tool-result call.
		const reports = agent.stabilityMonitor.history();
		expect(reports).toHaveLength(2);
		const second = reports[1];
		expect(second?.firstDivergence).toBe("appended");
		expect(second?.systemChanged).toBe(false);
		expect(second?.toolsChanged).toBe(false);
		expect(second?.stablePrefixBytes).toBe(reports[0]?.totalBytes);
		expect(second?.cause).toEqual(["appended"]);
	});

	it("attributes a system prompt change to the system section", async () => {
		const mock = createMockModel({
			responses: [{ content: ["one"] }, { content: ["two"] }],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["You are a test assistant."],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		await agent.prompt("first");
		agent.setSystemPrompt(["You are a DIFFERENT assistant."]);
		await agent.prompt("second");

		const second = agent.stabilityMonitor.last();
		expect(second?.firstDivergence).toBe("system");
		expect(second?.systemChanged).toBe(true);
		expect(second?.prefixRebuilt).toBe(true);
		expect(second?.cause).toContain("system-prompt-changed");
	});

	it("attributes a tool set change to the tools boundary with added/removed names", async () => {
		const toolSchema = type({ value: "string" });
		const makeTool = (name: string): AgentTool<typeof toolSchema, { value: string }> => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: { value: "ok" } };
			},
		});
		const mock = createMockModel({
			responses: [{ content: ["one"] }, { content: ["two"] }],
		});
		const alpha = makeTool("alpha");
		const beta = makeTool("beta");
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["You are a test assistant."],
				tools: [alpha],
				messages: [],
			},
			streamFn: mock.stream,
		});

		await agent.prompt("first");
		agent.setTools([beta]);
		await agent.prompt("second");

		const second = agent.stabilityMonitor.last();
		expect(second?.firstDivergence).toBe("tools");
		expect(second?.toolsChanged).toBe(true);
		expect(second?.toolNamesAdded).toEqual(["beta"]);
		expect(second?.toolNamesRemoved).toEqual(["alpha"]);
		expect(second?.cause).toContain("tool-set-changed");
	});
	it("keeps the worker prefix warm when advisor feedback is appended mid-trajectory", async () => {
		const mock = createMockModel({
			responses: [{ content: ["answer one"] }, { content: ["answer two"] }],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["You are a test assistant."],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		await agent.prompt("first question");
		const first = agent.stabilityMonitor.last();

		// Advisor feedback enters the worker trajectory as a new appended card
		// (session-level sendCustomMessage delivery; the wire form is a new
		// message at the tail). It must not regenerate the system prompt, the
		// tool set, or any earlier message.
		agent.state.messages.push({
			role: "user",
			content: "advisor: fix the off-by-one before continuing",
			timestamp: Date.now(),
		});

		await agent.prompt("second question");
		const second = agent.stabilityMonitor.last();

		expect(second?.firstDivergence).toBe("appended");
		expect(second?.systemChanged).toBe(false);
		expect(second?.toolsChanged).toBe(false);
		expect(second?.modelChanged).toBe(false);
		// Everything established before the card remains a byte-prefix of the
		// new request; only the card and the new turn extend the tail.
		expect(second?.stablePrefixBytes).toBe(first?.totalBytes);
		expect(second?.cause).toEqual(["appended"]);
	});

	it("keeps an extension-provided system fragment stable until the fragment itself changes", async () => {
		const base = "You are a test assistant.";
		const mock = createMockModel({
			responses: [{ content: ["one"] }, { content: ["two"] }, { content: ["three"] }],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: [base, "extension-fragment: use tabs, not spaces"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		await agent.prompt("first");
		const first = agent.stabilityMonitor.last();

		// Extension unchanged: its fragment bytes stay inside the stable
		// prefix across turns.
		await agent.prompt("second");
		const second = agent.stabilityMonitor.last();
		expect(second?.systemChanged).toBe(false);
		expect(second?.toolsChanged).toBe(false);
		expect(second?.stablePrefixBytes).toBe(first?.totalBytes);

		// Extension reload changes only its fragment: the invalidation is
		// attributed to the system section, never to tools or history.
		agent.setSystemPrompt([base, "extension-fragment: use spaces, not tabs"]);
		await agent.prompt("third");
		const third = agent.stabilityMonitor.last();
		expect(third?.firstDivergence).toBe("system");
		expect(third?.systemChanged).toBe(true);
		expect(third?.toolsChanged).toBe(false);
		expect(third?.cause).toContain("system-prompt-changed");
	});
});
