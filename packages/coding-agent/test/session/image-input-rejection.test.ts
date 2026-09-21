/**
 * Runtime image-capability correction for local backends.
 *
 * A locally served engine dies mid-decode instead of rejecting a request, so a
 * prompt it cannot serve fails *identically* on every replay — llama.cpp's
 * speculative-decoding draft path refuses any prompt carrying an image chunk,
 * which is how a snapcompact frame or a pasted screenshot wedges a session:
 * the retry budget is spent re-poisoning the server's slot cache while the turn
 * can never succeed.
 *
 * The contract this test defends: after the first such failure the session's
 * live model no longer declares image input, so every image gate — the
 * outbound scrub that keeps images off the wire, the snapcompact frame budget,
 * the attachment-description fallback — follows and the replay can succeed.
 *
 * The negative cases pin the two ways that correction must NOT fire: a hosted
 * provider's 5xx (a transient capacity event; withdrawing image input there
 * would silently drop what the user attached) and a local 5xx on a branch with
 * no images at all (nothing attributes the failure to image content). A local
 * 4xx is also left alone: that is a request verdict the backend reached on
 * purpose, not the mid-decode death this correction owns.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const IMAGE: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
/** The llama.cpp decode failure that motivated the correction. */
const DECODE_FAILURE = "decode() failed: failed to process speculative batch";

interface FailedTurn {
	model: Model;
	branchHasImage: boolean;
	status: number;
	errorMessage?: string;
}

function visionModel(provider: string, baseUrl: string): Model {
	return buildModel({
		id: "qwen3.8-27b-vl",
		name: "qwen3.8-27b-vl",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 222_208,
		maxTokens: 8_192,
	} as ModelSpec);
}

describe("local backend image-input rejection", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	async function runFailedTurn(turn: FailedTurn): Promise<{ session: AgentSession; notices: string[] }> {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: turn.branchHasImage
					? [{ type: "text", text: "what is in this frame?" }, IMAGE]
					: "what is in this frame?",
				timestamp: Date.now(),
			} as AgentMessage,
		];
		const sessionManager = SessionManager.inMemory();
		for (const message of messages) sessionManager.appendMessage(message as never);
		const agent = new Agent({
			initialState: { model: turn.model, systemPrompt: ["Test"], tools: [], messages },
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			// Retries off: the correction must land from the failure itself, not
			// from the retry path.
			settings: Settings.isolated({ "retry.enabled": false, "compaction.autoContinue": false }),
			modelRegistry,
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		// Deliver the failure the way the agent loop does, so the correction runs
		// on the real agent_end path — before any retry or fallback is scheduled.
		const failed = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "openai-completions",
			provider: turn.model.provider,
			model: turn.model.id,
			stopReason: "error",
			errorStatus: turn.status,
			errorMessage: `${turn.status} ${turn.errorMessage ?? DECODE_FAILURE}`,
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		failed.errorId = AIError.classifyMessage(failed);
		agent.emitExternalEvent({ type: "message_end", message: failed });
		agent.emitExternalEvent({ type: "agent_end", messages: [failed] });
		await session.waitForIdle();
		return { session, notices };
	}

	it("withdraws image input from a local backend that failed with images attached", async () => {
		const model = visionModel("llama.cpp", "http://127.0.0.1:8080/v1");
		expect(sendsImageInputOnWire(model)).toBe(true);

		const { session, notices } = await runFailedTurn({ model, branchHasImage: true, status: 500 });

		expect(session.model?.id).toBe(model.id);
		expect(sendsImageInputOnWire(session.model as Model)).toBe(false);
		expect(notices.some(message => message.includes("without images"))).toBe(true);
		await session.dispose();
	});

	it("leaves image input alone for a hosted provider's server error", async () => {
		const model = visionModel("myproxy", "https://proxy.example.com/v1");

		const { session, notices } = await runFailedTurn({ model, branchHasImage: true, status: 500 });

		expect(sendsImageInputOnWire(session.model as Model)).toBe(true);
		expect(notices.some(message => message.includes("without images"))).toBe(false);
		await session.dispose();
	});

	it("leaves image input alone when the failed branch carried no images", async () => {
		const model = visionModel("llama.cpp", "http://127.0.0.1:8080/v1");

		const { session } = await runFailedTurn({ model, branchHasImage: false, status: 500 });

		expect(sendsImageInputOnWire(session.model as Model)).toBe(true);
		await session.dispose();
	});

	it("leaves image input alone for a local request rejection", async () => {
		const model = visionModel("llama.cpp", "http://127.0.0.1:8080/v1");

		// A 4xx is a verdict the backend reached on purpose ("failed to load
		// image", unsupported media type) — not a mid-decode death.
		const { session } = await runFailedTurn({
			model,
			branchHasImage: true,
			status: 400,
			errorMessage: "failed to load image",
		});

		expect(sendsImageInputOnWire(session.model as Model)).toBe(true);
		await session.dispose();
	});
});
