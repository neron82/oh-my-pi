/**
 * Advisor interaction prompt stability — real session path.
 *
 * Advisor feedback enters the worker trajectory through `sendCustomMessage`
 * (the same entry point the advisor roster uses for concern/blocker cards,
 * with `deliverAs: "steer" | "nextTurn"`). When the session is idle that path
 * is a pure `agent.appendMessage`: the card must extend the trajectory tail
 * without regenerating the worker's system prompt, tool set, or any earlier
 * message. The stability monitor therefore reports the previous request in
 * full as the stable prefix of the next one (`cause: "appended"`).
 *
 * This composes with the agent-level contract tests
 * (packages/agent/test/prompt-stability-turns.test.ts) and the functional
 * advisor tests (test/advisor-toggle.test.ts, which cover delivery timing and
 * card preservation).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const sharedDir = TempDir.createSync("@pi-advisor-stability-shared-");
const sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
sharedAuthStorage.setRuntimeApiKey("mock", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));

afterAll(() => {
	sharedAuthStorage.close();
	sharedDir.removeSync();
});

let session: AgentSession | undefined;
let tempDir: TempDir | undefined;

afterEach(async () => {
	if (session) {
		await session.dispose();
		session = undefined;
	}
	if (tempDir) {
		tempDir.removeSync();
		tempDir = undefined;
	}
});

function text(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

async function createSession(responses: MockResponse[]): Promise<AgentSession> {
	tempDir = TempDir.createSync("@pi-advisor-stability-");
	const mock = createMockModel({ responses });
	sharedAuthStorage.setRuntimeApiKey(mock.provider, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["You are a test assistant."],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	const created = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: sharedModelRegistry,
	});
	return created;
}

describe("Advisor interaction prompt stability (session path)", () => {
	it("delivers an advisor card via sendCustomMessage without invalidating the worker prefix", async () => {
		session = await createSession([text("answer one"), text("answer two")]);

		await session.sendUserMessage("first question");
		const first = session.agent.stabilityMonitor.last();
		expect(first?.requestIndex).toBe(1);

		// The advisor roster's delivery entry point, idle (non-streaming)
		// form: the card is appended to the worker trajectory.
		await session.sendCustomMessage({
			customType: "advisor",
			content: "advisor: fix the off-by-one before continuing",
			display: true,
			attribution: "agent",
		});

		// The card really entered the trajectory (guards against a vacuous
		// stability pass if the wire form ever drops the card).
		const card = session.agent.state.messages.find(message => message.role === "custom");
		expect(card?.role).toBe("custom");

		await session.sendUserMessage("second question");
		const second = session.agent.stabilityMonitor.last();

		expect(second?.requestIndex).toBe(2);
		expect(second?.firstDivergence).toBe("appended");
		expect(second?.systemChanged).toBe(false);
		expect(second?.toolsChanged).toBe(false);
		expect(second?.modelChanged).toBe(false);
		// Everything established before the card (request #1 in full) remains
		// a byte-prefix of request #2; the card and the new turn extend the
		// tail only.
		expect(second?.stablePrefixBytes).toBe(first?.totalBytes);
		expect(second?.cause).toEqual(["appended"]);
	});
});
