/**
 * Fake LSP server for the mux overflow-teardown test: records its own pid in
 * the working directory, emits a Content-Length header far beyond any sane
 * frame cap, then sleeps. If the mux fails to kill an overflowing server,
 * this process leaks for the sleep's duration.
 */
import * as path from "node:path";

await Bun.write(path.join(process.cwd(), "overflow.pid"), String(process.pid));
process.stdout.write("Content-Length: 100000000\r\n\r\n");
await Bun.sleep(100);
await Bun.sleep(120_000);
