/**
 * Fake LSP server for the mux overflow-teardown test: records its own pid in
 * the working directory, announces the largest frame the framer accepts
 * (`Content-Length` exactly at the 64 MiB pending-byte cap), then streams that
 * much body without ever completing the frame.
 *
 * That is the path where the framer reports {@link MessageFramer.overflowed}
 * instead of throwing: the header is legal, so only the pending-byte cap trips.
 * A mux that does not consult `overflowed` therefore leaves this process alive
 * for the sleep below — the test times out waiting for the kill.
 */
import * as path from "node:path";

await Bun.write(path.join(process.cwd(), "overflow.pid"), String(process.pid));
const bodyBytes = 64 * 1024 * 1024;
process.stdout.write(`Content-Length: ${bodyBytes}\r\n\r\n`);
const chunk = Buffer.alloc(1024 * 1024, 0x20);
for (let written = 0; written < bodyBytes; written += chunk.length) {
	// Await the write callback so backpressure cannot balloon the child's heap.
	const { promise, resolve } = Promise.withResolvers<void>();
	process.stdout.write(chunk, () => resolve());
	await promise;
}
await Bun.sleep(120_000);
