import { afterEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { DapClient } from "../../src/dap/client";
import type { DapResolvedAdapter } from "../../src/dap/types";

const adapter: DapResolvedAdapter = {
	name: "overflow-test",
	command: "overflow-test-adapter",
	args: [],
	resolvedCommand: "overflow-test-adapter",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "tcp",
	acceptsDirectoryProgram: false,
};

async function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
	// Real socket integration needs a wall-clock failure watchdog; always cancel it when the event wins.
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("DAP frame buffer overflow teardown", () => {
	let server: net.Server | undefined;
	const serverSockets: net.Socket[] = [];

	afterEach(() => {
		for (const socket of serverSockets.splice(0)) socket.destroy();
		server?.close();
		server = undefined;
	});

	it("rejects pending requests and closes the adapter socket", async () => {
		const clientClosed = Promise.withResolvers<void>();
		const srv = net.createServer(socket => {
			serverSockets.push(socket);
			let settled = false;
			const settle = (): void => {
				if (settled) return;
				settled = true;
				clientClosed.resolve();
			};
			// The peer's FIN (client-side socket.end) or a full close both prove
			// the client tore the transport down.
			socket.once("end", settle);
			socket.once("close", settle);
			socket.on("data", chunk => {
				// Answer once the client's initialize request arrives, so the
				// request is registered pending before the overflow lands.
				if (Buffer.isBuffer(chunk) && chunk.includes("initialize")) {
					// A declared Content-Length far beyond the framing cap: the
					// client's framer must flag overflow from this header alone.
					socket.write("Content-Length: 100000000\r\n\r\n");
				}
			});
		});
		server = srv;
		await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", () => resolve()));
		const { port } = srv.address() as net.AddressInfo;

		const client = await DapClient.connect({
			adapter,
			cwd: process.cwd(),
			host: "127.0.0.1",
			port,
		});
		const pending = client.sendRequest("initialize", {}, undefined, 10_000);
		const error = await new Promise<Error>((resolve, reject) => {
			pending.then(
				() => reject(new Error("request unexpectedly succeeded")),
				(err: unknown) => resolve(err instanceof Error ? err : new Error(String(err))),
			);
		});
		expect(error.message).toContain("overflow");
		// Teardown contract: the client must close the live adapter transport,
		// not leave it behind with an unread pipe.
		await withTimeout(clientClosed.promise, "client socket close");
	});
});
