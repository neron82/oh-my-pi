import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type CompactionPreparation,
	buildSummarizationInstruction,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateSummary,
	SUMMARIZATION_SYSTEM_PROMPT,
} from "@oh-my-pi/pi-agent-core/compaction";
import { Agent } from "../src/agent";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { AssistantMessage, Context, Message, Model, Tool } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

const liveTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } } } as Tool["parameters"],
};

const liveMessages = [
	{ role: "user" as const, content: "start work", timestamp: 1 },
	{
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "started" }],
		timestamp: 2,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
	},
];

function liveBase(): { systemPrompt: string[]; tools: Tool[]; messages: Message[] } {
	return {
		systemPrompt: ["live-system"],
		tools: [liveTool],
		messages: liveMessages,
	};
}

function messageText(message: { content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part: { type?: string }) => part?.type === "text")
			.map((part: { text?: string }) => part.text ?? "")
			.join("");
	}
	return "";
}

function makePreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: liveMessages,
		turnPrefixMessages: [],
		recentMessages: [{ role: "user" as const, content: "recent", timestamp: 3 }],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: createFileOps(),
		settings: {
			...DEFAULT_COMPACTION_SETTINGS,
			remoteEnabled: false,
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("KV-aligned compaction", () => {
	test("generateSummary sends the supplied context verbatim with toolChoice none", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		const base = liveBase();

		const summary = await generateSummary(liveMessages, getModel(), 10_000, "test-key", undefined, undefined, undefined, {
			kvAlignedContext: base,
		});

		expect(summary).toBe("summary");
		expect(spy).toHaveBeenCalledTimes(1);
		const context = spy.mock.calls[0]?.[1] as Context;
		expect(context).toBe(base); // adopted by reference: wire bytes are exactly what the live request recorded
		expect(context.systemPrompt).toEqual(["live-system"]);
		expect(context.tools).toEqual([liveTool]);
		expect(context.messages).toBe(liveMessages);
		expect(spy.mock.calls[0]?.[2]?.toolChoice).toBe("none");
	});

	test("without a KV context, the text-serialized path is unchanged", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));

		await generateSummary(liveMessages, getModel(), 10_000, "test-key");

		const context = spy.mock.calls[0]?.[1] as Context;
		expect(context.systemPrompt).toEqual([SUMMARIZATION_SYSTEM_PROMPT]);
		expect(context.tools).toBeUndefined();
		expect(spy.mock.calls[0]?.[2]?.toolChoice).toBeUndefined();
		expect(messageText(context.messages[0] as { content: unknown })).toContain("<conversation>");
	});

	test("compact() folds the KV base into a prefix-extension request with the exact instruction appended", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		const preparation = makePreparation();

		await compact(
			preparation,
			getModel(),
			"test-key",
			"focus on the tests",
			undefined,
			{
				kvAlignedBaseContext: liveBase(),
			},
		);

		// Two oneshot calls: history summary + short summary.
		expect(spy).toHaveBeenCalledTimes(2);
		const summaryCall = spy.mock.calls[0]!;
		const context = summaryCall[1] as Context;

		// The live system prompt and tools are replayed, not the summarization prompt.
		expect(context.systemPrompt).toEqual(["live-system"]);
		expect(context.tools).toEqual([liveTool]);

		// The shadowed region is verbatim, followed by exactly one appended instruction.
		expect(context.messages.length).toBe(liveMessages.length + 1);
		for (let i = 0; i < liveMessages.length; i++) {
			expect(context.messages[i]).toBe(liveMessages[i]);
		}
		const instruction = messageText(context.messages[liveMessages.length] as { content: unknown });
		expect(instruction).toBe(
			buildSummarizationInstruction({
				previousSummary: undefined,
				customInstructions: "focus on the tests",
			}),
		);
		expect(instruction).toContain("focus on the tests");
		expect(instruction).not.toContain("<conversation>");
		expect(summaryCall[2]?.toolChoice).toBe("none");
	});

	test("compact() keeps the text path when no KV base is supplied", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		const preparation = makePreparation();

		await compact(preparation, getModel(), "test-key");

		const context = spy.mock.calls[0]?.[1] as Context;
		expect(context.systemPrompt).toEqual([SUMMARIZATION_SYSTEM_PROMPT]);
		expect(messageText(context.messages[0] as { content: unknown })).toContain("<conversation>");
	});

	test("buildSummarizationInstruction is deterministic for identical inputs", () => {
		const args = {
			previousSummary: "earlier summary",
			customInstructions: "focus on the tests",
			extraContext: ["extra context block"],
		};
		expect(buildSummarizationInstruction(args)).toBe(buildSummarizationInstruction({ ...args }));
		expect(buildSummarizationInstruction(args)).not.toBe(
			buildSummarizationInstruction({ ...args, previousSummary: "different summary" }),
		);
	});
});

describe("Agent.buildProviderContextForMessages", () => {
	const model = createMockModel({ responses: [] });

	test("replays the live pipeline in the same order as the live loop", async () => {
		const steps: string[] = [];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["base"], tools: [] },
			transformContext: async messages => {
				steps.push("transformContext");
				return messages;
			},
			convertToLlm: messages => {
				steps.push("convertToLlm");
				return messages as unknown as Message[];
			},
			transformProviderContext: async context => {
				steps.push("transformProviderContext");
			return { ...context, systemPrompt: [...(context.systemPrompt ?? []), "hook"] };
			},
		});

		const context = await agent.buildProviderContextForMessages(
			[{ role: "user", content: "hi", timestamp: 1 }],
			model,
		);

		expect(steps).toEqual(["transformContext", "convertToLlm", "transformProviderContext"]);
		expect(context.systemPrompt).toEqual(["base", "hook"]);
	});

	test("reuses the agent's live system prompt and tool state", async () => {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["base"], tools: [] },
		});

		const context = await agent.buildProviderContextForMessages(
			[{ role: "user", content: "hi", timestamp: 1 }],
			model,
		);

		expect(context.systemPrompt).toEqual(["base"]);
		expect(context.messages).toHaveLength(1);
	});
});
