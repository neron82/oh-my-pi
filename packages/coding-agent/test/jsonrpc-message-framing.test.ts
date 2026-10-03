/**
 * MessageFramer pending-byte cap — DoS guard for the LSP/DAP stdio framing
 * shared by the lsp and dap clients (and the lsp mux).
 *
 * A server that lies about Content-Length or never terminates a frame must
 * not be able to grow the client's pending buffer without bound. Contract:
 * once pending bytes (or a declared body) exceed the cap, `overflowed` is
 * set and `remainder` is empty. Framing violations throw a sticky error;
 * raw pending-byte overflow stops buffering so the reader can tear down the
 * connection.
 */
import { describe, expect, it } from "bun:test";
import { MessageFramer } from "@oh-my-pi/pi-coding-agent/jsonrpc/message-framing";

function frame(text: string): Buffer {
	return Buffer.from(`Content-Length: ${Buffer.byteLength(text, "utf8")}\r\n\r\n${text}`, "utf8");
}

describe("MessageFramer pending-byte cap", () => {
	it("overflows on a declared Content-Length beyond the cap", () => {
		const framer = new MessageFramer(Buffer.alloc(0), 1024);
		framer.push(Buffer.from("Content-Length: 1000000\r\n\r\n", "latin1"));
		// The reader gets the framing cause immediately and can tear down the peer.
		expect(() => [...framer.drain(() => {})]).toThrow(/Content-Length.*limit/);
		expect(framer.overflowed).toBe(true);
		// A failed parser rejects further input and cannot keep buffering.
		expect(() => framer.push(Buffer.alloc(4096))).toThrow(/Content-Length/);
		expect(framer.overflowed).toBe(true);
		expect(framer.remainder().length).toBe(0);
	});

	it("overflows when accumulated bytes exceed the cap", () => {
		const framer = new MessageFramer(Buffer.alloc(0), 1024);
		// Chunked framing has no declared total, so accumulation hits the cap.
		framer.push(Buffer.from("Transfer-Encoding: chunked\r\n\r\n", "latin1"));
		framer.push(Buffer.from("800\r\n", "latin1")); // announces a 2048-byte chunk
		framer.push(Buffer.alloc(2048));
		expect(framer.overflowed).toBe(true);
		framer.push(Buffer.alloc(4096)); // must not grow further
		expect(framer.remainder().length).toBe(0);
	});

	it("starts overflowed when the persisted seed exceeds the cap", () => {
		const framer = new MessageFramer(Buffer.alloc(2048), 1024);
		expect(framer.overflowed).toBe(true);
		framer.push(Buffer.alloc(64));
		expect([...framer.drain(() => {})]).toEqual([]);
		expect(framer.remainder().length).toBe(0);
	});
	it("still frames messages under the cap", () => {
		const framer = new MessageFramer(Buffer.alloc(0), 1024);
		const message = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" });
		framer.push(frame(message));
		expect([...framer.drain(() => {})]).toEqual([message]);
		expect(framer.overflowed).toBe(false);
		expect(framer.remainder().length).toBe(0);
	});
});
