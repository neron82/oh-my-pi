/**
 * Fork-only contract: the daemon `lsp` module must tear down a language server
 * whose output exceeds the frame cap. The fork's bounded `MessageFramer`
 * reports a cap hit instead of throwing, so every reader has to check it —
 * without that check the server leaks and its session hangs. Ported from the
 * removed `test/lsp-mux.test.ts` after upstream folded the mux into the daemon.
 */
import { afterEach, beforeEach, describe, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { daemonClient, isolateDaemonForSmokeTest } from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient, DaemonTunnel } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import {
	LSP_ACQUIRE_METHOD,
	LSP_MODULE_KIND,
	type LspAcquireResult,
	type LspServerParams,
	type LspUnitParams,
} from "@oh-my-pi/pi-coding-agent/lsp/mux/protocol";
import { TempDir } from "@oh-my-pi/pi-utils";

const OVERFLOW_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "fake-lsp-server-overflow.ts");
const DAEMON_TEST_TIMEOUT_MS = 60_000;
const WAIT_MS = 15_000;

let restoreDaemon: (() => Promise<void>) | undefined;
let workspace: TempDir | undefined;
let cwd = "";
let tunnel: DaemonTunnel | undefined;

beforeEach(async () => {
	restoreDaemon = await isolateDaemonForSmokeTest();
	workspace = TempDir.createSync("@omp-lsp-overflow-");
	cwd = await fs.realpath(workspace.path());
});

afterEach(async () => {
	await shutdownAll();
	tunnel?.close();
	tunnel = undefined;
	await restoreDaemon?.();
	restoreDaemon = undefined;
	await workspace?.remove();
	workspace = undefined;
});

/** Polls another process (the daemon); there is no in-process signal to await. */
async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + WAIT_MS;
	while (true) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("daemon lsp module overflow", () => {
	test(
		"kills a server whose frame buffer overflows and closes the session",
		async () => {
			const client: DaemonClient = await daemonClient();
			const server: LspServerParams = { command: process.execPath, args: ["run", OVERFLOW_FIXTURE], cwd };
			const reservation = await client.call<LspAcquireResult>(LSP_MODULE_KIND, LSP_ACQUIRE_METHOD, server);
			const spawnEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
			if (process.env.HOME) spawnEnv.HOME = process.env.HOME;
			if (process.env.TMPDIR) spawnEnv.TMPDIR = process.env.TMPDIR;
			const opened = await client.open({
				kind: LSP_MODULE_KIND,
				scope: reservation.scope,
				key: reservation.key,
				params: { ...server, spawnEnv } satisfies LspUnitParams,
			});
			let closed = false;
			tunnel = await client.attach(opened.unit.id, reservation.token);
			tunnel.start(
				() => {},
				() => {
					closed = true;
				},
			);

			const pid = await until("the overflow fixture pid", async () => {
				const text = await fs.readFile(path.join(cwd, "overflow.pid"), "utf8").catch(() => "");
				return text.trim().length > 0 ? Number(text.trim()) : undefined;
			});
			await until("the overflowing server to be killed", () => (isProcessAlive(pid) ? undefined : true));
			await until("the session tunnel to close", () => (closed ? true : undefined));
		},
		DAEMON_TEST_TIMEOUT_MS,
	);
});
