/**
 * LLM request dump sidecar — file hygiene for `/dump` and copy-session export.
 *
 * The sidecar holds raw session context (system prompt, tool schemas,
 * converted messages — including anything the user pasted, credentials
 * included). The contract under test: files are created owner-only (0600,
 * never left world-readable by the process umask) and stale sidecars are
 * swept after the retention window so they do not accumulate in $TMPDIR.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, pruneStaleLlmRequestDumps } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const sharedDir = TempDir.createSync("@pi-llm-request-dump-shared-");
const sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
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

function text(content: string): MockResponse {
	return { content: [content], stopReason: "stop" };
}

async function createSession(): Promise<{ session: AgentSession; mock: MockModel }> {
	tempDir = TempDir.createSync("@pi-llm-request-dump-");
	const mock = createMockModel({ responses: [text("ok")] });
	sharedAuthStorage.setRuntimeApiKey(mock.provider, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
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
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: sharedModelRegistry,
	});
	return { session, mock };
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch {
		return false;
	}
}

describe("LLM request dump sidecar", () => {
	it("writes the sidecar owner-only (0600) containing the session context", async () => {
		if (process.platform === "win32") return; // POSIX permission contract
		const created = await createSession();
		session = created.session;
		await session.sendUserMessage("hello sidecar");
		// The mock's `calls` log holds a back-reference to the model (test
		// instrumentation); real catalog models are plain descriptors and
		// stringify cleanly.
		created.mock.calls.length = 0;
		const filePath = await session.dumpLlmRequestToTmpDir();
		expect(filePath).toBeDefined();
		try {
			const stats = await fs.stat(filePath!);
			expect(stats.mode & 0o777).toBe(0o600);
			const content = JSON.parse(await fs.readFile(filePath!, "utf8"));
			expect(JSON.stringify(content.messages)).toContain("hello sidecar");
		} finally {
			await fs.unlink(filePath!).catch(() => {});
		}
	}, 15_000);

	it("sweeps stale sidecars but keeps fresh and unrelated files", async () => {
		const dir = TempDir.createSync("@pi-llm-request-dump-sweep-");
		try {
			const staleSeconds = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
			await fs.writeFile(path.join(dir.path(), "omp-llm-request-stale.json"), "{}");
			await fs.utimes(path.join(dir.path(), "omp-llm-request-stale.json"), staleSeconds, staleSeconds);
			await fs.writeFile(path.join(dir.path(), "omp-llm-request-fresh.json"), "{}");
			await fs.writeFile(path.join(dir.path(), "omp-llm-request-notes.txt"), "{}");
			await fs.writeFile(path.join(dir.path(), "other.json"), "{}");

			await pruneStaleLlmRequestDumps(dir.path());

			expect(await exists(path.join(dir.path(), "omp-llm-request-stale.json"))).toBe(false);
			expect(await exists(path.join(dir.path(), "omp-llm-request-fresh.json"))).toBe(true);
			expect(await exists(path.join(dir.path(), "omp-llm-request-notes.txt"))).toBe(true);
			expect(await exists(path.join(dir.path(), "other.json"))).toBe(true);
		} finally {
			dir.removeSync();
		}
	});
});
