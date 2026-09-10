import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { DeferredRunManager } from "@oh-my-pi/pi-coding-agent/session/deferred-run-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	CURRENT_SESSION_VERSION,
	type DeferredResumeEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("DeferredRunManager", () => {
	it("schedules a deferred resume for a future timestamp", async () => {
		using tempDir = TempDir.createSync("@omp-deferred-");
		const sessionFile = path.join(tempDir.path(), "test.jsonl");

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "test-session",
			timestamp: new Date().toISOString(),
			cwd: tempDir.path(),
			generation: 42,
		};

		const entry: DeferredResumeEntry = {
			type: "deferred_resume",
			id: "deferred-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			resume_at: Date.now() + 10000,
			generation: 42,
			error_message: "Usage limit reached",
			model: "anthropic/claude-sonnet-4-20250514",
			reason: "usage_limit_reached",
		};

		let resumed = false;
		const manager = new DeferredRunManager({
			listSessions: async () => [{ sessionId: "test-session", sessionFile }],
			loadSessionHeader: async () => header,
			findDeferredResume: async () => entry,
			consumeDeferredResume: async () => true,
			cancelDeferredResume: async () => {},
			resumeSession: () => {
				resumed = true;
			},
		});

		manager.scheduleResume("test-session", sessionFile, entry);

		expect(manager.hasPendingResume("test-session")).toBe(true);
		expect(resumed).toBe(false);

		manager.destroy();
	});

	it("resumes immediately when resume_at has passed", async () => {
		using tempDir = TempDir.createSync("@omp-deferred-");
		const sessionFile = path.join(tempDir.path(), "test.jsonl");

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "test-session",
			timestamp: new Date().toISOString(),
			cwd: tempDir.path(),
			generation: 42,
		};

		const entry: DeferredResumeEntry = {
			type: "deferred_resume",
			id: "deferred-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			resume_at: Date.now() - 1000,
			generation: 42,
			error_message: "Usage limit reached",
			model: "anthropic/claude-sonnet-4-20250514",
			reason: "usage_limit_reached",
		};

		let resumedSessionId: string | undefined;
		const manager = new DeferredRunManager({
			listSessions: async () => [{ sessionId: "test-session", sessionFile }],
			loadSessionHeader: async () => header,
			findDeferredResume: async () => entry,
			consumeDeferredResume: async () => true,
			cancelDeferredResume: async () => {},
			resumeSession: sessionId => {
				resumedSessionId = sessionId;
			},
		});

		await manager.init();

		expect(resumedSessionId).toBe("test-session");
		manager.destroy();
	});

	it("discards stale resume when generation mismatches", async () => {
		using tempDir = TempDir.createSync("@omp-deferred-");
		const sessionFile = path.join(tempDir.path(), "test.jsonl");

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "test-session",
			timestamp: new Date().toISOString(),
			cwd: tempDir.path(),
			generation: 43,
		};

		const entry: DeferredResumeEntry = {
			type: "deferred_resume",
			id: "deferred-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			resume_at: Date.now() - 1000,
			generation: 42,
			error_message: "Usage limit reached",
			model: "anthropic/claude-sonnet-4-20250514",
			reason: "usage_limit_reached",
		};

		let resumed = false;
		const manager = new DeferredRunManager({
			listSessions: async () => [{ sessionId: "test-session", sessionFile }],
			loadSessionHeader: async () => header,
			findDeferredResume: async () => entry,
			consumeDeferredResume: async () => true,
			cancelDeferredResume: async () => {},
			resumeSession: () => {
				resumed = true;
			},
		});

		await manager.init();

		expect(resumed).toBe(false);
		manager.destroy();
	});

	it("skips consumed entries", async () => {
		using tempDir = TempDir.createSync("@omp-deferred-");
		const sessionFile = path.join(tempDir.path(), "test.jsonl");

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "test-session",
			timestamp: new Date().toISOString(),
			cwd: tempDir.path(),
			generation: 42,
		};

		const entry: DeferredResumeEntry = {
			type: "deferred_resume",
			id: "deferred-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			resume_at: Date.now() - 1000,
			generation: 42,
			error_message: "Usage limit reached",
			model: "anthropic/claude-sonnet-4-20250514",
			reason: "usage_limit_reached",
			consumed: true,
		};

		let resumed = false;
		const manager = new DeferredRunManager({
			listSessions: async () => [{ sessionId: "test-session", sessionFile }],
			loadSessionHeader: async () => header,
			findDeferredResume: async () => entry,
			consumeDeferredResume: async () => true,
			cancelDeferredResume: async () => {},
			resumeSession: () => {
				resumed = true;
			},
		});

		await manager.init();

		expect(resumed).toBe(false);
		manager.destroy();
	});

	it("handles multiple deferred sessions", async () => {
		using tempDir = TempDir.createSync("@omp-deferred-");
		const sessionFile1 = path.join(tempDir.path(), "session1.jsonl");
		const sessionFile2 = path.join(tempDir.path(), "session2.jsonl");

		const headers: Record<string, SessionHeader> = {
			[sessionFile1]: {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: tempDir.path(),
				generation: 10,
			},
			[sessionFile2]: {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "session-2",
				timestamp: new Date().toISOString(),
				cwd: tempDir.path(),
				generation: 20,
			},
		};

		const entries: Record<string, DeferredResumeEntry> = {
			[sessionFile1]: {
				type: "deferred_resume",
				id: "deferred-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				resume_at: Date.now() - 1000,
				generation: 10,
				error_message: "Usage limit reached",
				model: "anthropic/claude-sonnet-4-20250514",
				reason: "usage_limit_reached",
			},
			[sessionFile2]: {
				type: "deferred_resume",
				id: "deferred-2",
				parentId: null,
				timestamp: new Date().toISOString(),
				resume_at: Date.now() - 1000,
				generation: 20,
				error_message: "Usage limit reached",
				model: "openai/gpt-5",
				reason: "usage_limit_reached",
			},
		};

		const resumedSessions: string[] = [];
		const manager = new DeferredRunManager({
			listSessions: async () => [
				{ sessionId: "session-1", sessionFile: sessionFile1 },
				{ sessionId: "session-2", sessionFile: sessionFile2 },
			],
			loadSessionHeader: async file => headers[file] ?? null,
			findDeferredResume: async file => entries[file] ?? null,
			consumeDeferredResume: async () => true,
			cancelDeferredResume: async () => {},
			resumeSession: sessionId => {
				resumedSessions.push(sessionId);
			},
		});

		await manager.init();

		expect(resumedSessions).toContain("session-1");
		expect(resumedSessions).toContain("session-2");
		expect(resumedSessions.length).toBe(2);
		manager.destroy();
	});

	it("cancelResume clears timer and persists cancellation", async () => {
		using tempDir = TempDir.createSync("@omp-deferred-");
		const sessionFile = path.join(tempDir.path(), "test.jsonl");

		const entry: DeferredResumeEntry = {
			type: "deferred_resume",
			id: "deferred-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			resume_at: Date.now() + 10000,
			generation: 42,
			error_message: "Usage limit reached",
			model: "anthropic/claude-sonnet-4-20250514",
			reason: "usage_limit_reached",
		};

		let cancelCalled = false;
		const manager = new DeferredRunManager({
			listSessions: async () => [],
			loadSessionHeader: async () => null,
			findDeferredResume: async () => null,
			consumeDeferredResume: async () => false,
			cancelDeferredResume: async () => {
				cancelCalled = true;
			},
			resumeSession: () => {},
		});

		manager.scheduleResume("test-session", sessionFile, entry);
		expect(manager.hasPendingResume("test-session")).toBe(true);

		manager.cancelResume("test-session", sessionFile);
		expect(manager.hasPendingResume("test-session")).toBe(false);

		await Bun.sleep(10);
		expect(cancelCalled).toBe(true);

		manager.destroy();
	});
});

function text(content: string): MockResponse {
	return { content: [content], stopReason: "stop" };
}

describe("AgentSession deferred resume", () => {
	it("runs a continuation turn when the timer fires with an assistant message at the tail", async () => {
		using tempDir = TempDir.createSync("@omp-deferred-session-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const mock = createMockModel({ responses: [text("first reply"), text("continued work")] });
		authStorage.setRuntimeApiKey(mock.provider, "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
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
		const sessionManager = SessionManager.create(tempDir.path());
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		try {
			await session.prompt("hello");
			await session.waitForIdle();
			expect(mock.calls.length).toBe(1);

			// A usage-limit failure leaves an assistant message as the context
			// tail — the exact state the deferred timer must resume from.
			// agent.continue() rejects that role; the resume must inject a
			// continuation prompt so the session actually streams again.
			sessionManager.appendDeferredResume({
				type: "deferred_resume",
				id: "deferred-tail-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				resume_at: Date.now() - 1000,
				generation: sessionManager.getSessionGeneration() ?? 0,
				error_message: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
				model: `${mock.provider}/${mock.id}`,
				reason: "usage_limit_reached",
			});

			await session.resumeDeferredRuns();
			await session.waitForIdle();

			expect(mock.calls.length).toBe(2);
			const tail = agent.state.messages.at(-1);
			expect(tail?.role).toBe("assistant");
			const content = (tail as AssistantMessage).content
				.flatMap(part => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
				.join(" ");
			expect(content).toContain("continued work");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
