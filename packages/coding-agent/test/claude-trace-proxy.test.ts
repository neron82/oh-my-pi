/**
 * claude-trace proxy size caps — the debug MITM proxy buffers tunneled HTTP
 * messages and decodes compressed bodies. Contract: buffered messages and
 * decompressed output stay bounded (overflow flag / decompression fallback),
 * so a hostile or broken peer cannot grow the proxy's memory without bound.
 */

import { describe, expect, it } from "bun:test";
import * as net from "node:net";
import * as zlib from "node:zlib";
import {
	ClaudeMessagesProxy,
	decodeBody,
	type HeaderEntry,
	HttpMessageParser,
} from "@oh-my-pi/pi-coding-agent/cli/claude-trace-cli";

describe("claude-trace proxy caps", () => {
	it("overflows a declared Content-Length beyond the message cap", () => {
		const parser = new HttpMessageParser("request", 1024);
		parser.push(
			Buffer.from(
				"POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: 1000000\r\n\r\n",
				"latin1",
			),
		);
		expect(parser.overflowed).toBe(true);
		// push becomes a no-op after overflow: nothing is parsed or buffered.
		expect(parser.push(Buffer.alloc(2048))).toEqual([]);
		expect(parser.overflowed).toBe(true);
	});

	it("overflows when accumulated chunked bytes exceed the message cap", () => {
		const parser = new HttpMessageParser("request", 1024);
		parser.push(Buffer.from("POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n", "latin1"));
		expect(parser.overflowed).toBe(false);
		parser.push(Buffer.from("800\r\n", "latin1")); // announces a 2048-byte chunk
		parser.push(Buffer.alloc(2048));
		expect(parser.overflowed).toBe(true);
	});

	it("still frames messages under the cap", () => {
		const parser = new HttpMessageParser("request", 4096);
		const body = '{"model":"claude-sonnet-4-6","messages":[]}';
		const head = `POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n`;
		const messages = parser.push(Buffer.from(head + body, "latin1"));
		expect(parser.overflowed).toBe(false);
		expect(messages).toHaveLength(1);
		expect(messages[0].body.toString("utf8")).toBe(body);
	});

	it("caps decompressed body size and degrades to raw bytes", () => {
		const plain = "a".repeat(10_000);
		const compressed = zlib.gzipSync(Buffer.from(plain, "utf8"));
		const headers: HeaderEntry[] = [{ name: "content-encoding", value: "gzip" }];
		// Under the cap: decompresses fully.
		expect(decodeBody(headers, compressed)).toBe(plain);
		// Over the cap: zlib throws and the capture degrades to the raw
		// (compressed, bounded) bytes instead of the expansion.
		const degraded = decodeBody(headers, compressed, compressed.length - 1);
		expect(degraded).not.toBe(plain);
	});

	it("destroys a connection whose CONNECT head exceeds the cap", async () => {
		const proxy = new ClaudeMessagesProxy({ port: 0 });
		await proxy.start();
		try {
			const socket = net.connect(proxy.port, proxy.host);
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", () => resolve());
				socket.once("error", reject);
			});
			// Awaits the real `close` event; the timeout is only a hang guard
			// (deterministic time control cannot force a TCP teardown), so a
			// missing close fails the assertion instead of hanging the suite.
			const closed = new Promise<boolean>(resolve => {
				socket.once("close", () => resolve(true));
				setTimeout(() => resolve(false), 2000);
			});
			// 70 KB of header bytes with no CRLFCRLF terminator.
			socket.write(Buffer.alloc(70 * 1024, 0x41));
			expect(await closed).toBe(true);
		} finally {
			await proxy.stop();
		}
	}, 15_000);
});
