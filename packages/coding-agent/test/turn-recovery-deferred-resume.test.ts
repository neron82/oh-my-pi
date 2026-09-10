/**
 * Deferred-resume gating for usage-limit waits beyond `retry.maxDelayMs`.
 *
 * Contract under test: a hintless usage-limit error is parked into a durable
 * deferred resume only when the provider stated the timing — a complete usage
 * report, or a partial report whose known window boundary merged into the
 * credential block (`statedResetAtMs`). A purely heuristic wait must fail
 * fast so the error surfaces instead of parking the run on a guess.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { DeferredResumeEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Codex weekly-cap rejection with no retry hint in the text. */
function makeUsageLimitMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
		timestamp: Date.now(),
	};
}

type Capture = {
	events: AgentSessionEvent[];
	entries: DeferredResumeEntry[];
	scheduled: Array<{ sessionFile: string; entry: DeferredResumeEntry }>;
};

function createHost(model: Model, modelRegistry: ModelRegistry, capture: Capture): TurnRecoveryHost {
	const settings = Settings.isolated({});
	return {
		agent: { state: { messages: [] } } as never,
		sessionManager: {
			getSessionGeneration: () => 3,
			getSessionFile: () => "/tmp/deferred-gating.jsonl",
			appendDeferredResume: (entry: DeferredResumeEntry) => {
				capture.entries.push(entry);
				return entry.id;
			},
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		sessionId: () => "test-session",
		emitSessionEvent: async event => {
			capture.events.push(event);
		},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
		scheduleDeferredResume: (sessionFile: string, entry: DeferredResumeEntry) => {
			capture.scheduled.push({ sessionFile, entry });
		},
	};
}

describe("TurnRecovery deferred-resume gating", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-deferred-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parks a hintless multi-hour wait when a partial report states the reset", async () => {
		const capture: Capture = { events: [], entries: [], scheduled: [] };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, capture));
		const message = makeUsageLimitMessage(model);
		// Mirrors the observed weekly-cap case: the 5h window reports its
		// reset, the weekly window does not — the merged credential block is
		// still provider-timed to that reset.
		const blockedUntil = Date.now() + 17_237_567;
		vi.spyOn(authStorage, "markUsageLimitReached").mockResolvedValue({
			switched: false,
			blockedUntilMs: blockedUntil,
			statedResetAtMs: blockedUntil,
		});

		await recovery.recordUsageLimitOutcome(message);
		const retried = await recovery.handleRetryableError(message, { allowModelFallback: false });

		expect(retried).toBe(false);
		expect(capture.entries.length).toBe(1);
		const entry = capture.entries[0]!;
		expect(entry.reason).toBe("usage_limit_reached");
		expect(entry.generation).toBe(3);
		expect(entry.resume_at).toBeGreaterThan(Date.now() + 4 * 60 * 60 * 1000);
		expect(entry.resume_at).toBeLessThanOrEqual(blockedUntil + 2000);
		expect(capture.scheduled.length).toBe(1);
		expect(capture.scheduled[0]!.sessionFile).toBe("/tmp/deferred-gating.jsonl");
		const scheduledEvent = capture.events.find(event => event.type === "deferred_resume_scheduled");
		expect(scheduledEvent).toBeDefined();
		expect(capture.events.some(event => event.type === "auto_retry_end")).toBe(false);
	});

	it("fails fast when the only timing is the heuristic fallback", async () => {
		const capture: Capture = { events: [], entries: [], scheduled: [] };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, capture));
		const message = makeUsageLimitMessage(model);
		vi.spyOn(authStorage, "markUsageLimitReached").mockResolvedValue({
			switched: false,
			blockedUntilMs: Date.now() + 30 * 60 * 1000,
		});

		await recovery.recordUsageLimitOutcome(message);
		const retried = await recovery.handleRetryableError(message, { allowModelFallback: false });

		expect(retried).toBe(false);
		expect(capture.entries.length).toBe(0);
		expect(capture.scheduled.length).toBe(0);
		const endEvent = capture.events.find(event => event.type === "auto_retry_end");
		expect(endEvent?.type === "auto_retry_end" && endEvent.success).toBe(false);
	});
});
