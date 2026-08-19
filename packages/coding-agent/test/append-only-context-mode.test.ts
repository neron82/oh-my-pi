import { describe, expect, test } from "bun:test";
import { shouldEnableAppendOnlyContext } from "@oh-my-pi/pi-coding-agent/config/append-only-context-mode";

const GENERIC_PROXY = { provider: "some-proxy" };

describe("shouldEnableAppendOnlyContext", () => {
	test("honors explicit on and off settings", () => {
		expect(shouldEnableAppendOnlyContext("on", GENERIC_PROXY)).toBe(true);
		expect(shouldEnableAppendOnlyContext("on", null)).toBe(true);
		expect(shouldEnableAppendOnlyContext("off", { provider: "deepseek" })).toBe(false);
	});

	test("auto enables for every configured model", () => {
		// Uniform execution model: byte-stable prefixes are a strict superset
		// of what any provider-side cache needs, and the only guarantee for
		// KV-retaining local engines (prompt-cache stability).
		for (const model of [
			{ provider: "anthropic" },
			{ provider: "openai" },
			{ provider: "deepseek" },
			GENERIC_PROXY,
			{ provider: "ollama" },
			{ provider: "llama.cpp" },
			{ provider: "x" },
		]) {
			expect(shouldEnableAppendOnlyContext("auto", model)).toBe(true);
		}
	});

	test("auto stays off when no model is configured", () => {
		expect(shouldEnableAppendOnlyContext("auto", null)).toBe(false);
		expect(shouldEnableAppendOnlyContext("auto", undefined)).toBe(false);
		expect(shouldEnableAppendOnlyContext(undefined, null)).toBe(false);
	});

	test("off wins even for providers that used to auto-enable", () => {
		expect(shouldEnableAppendOnlyContext("off", { provider: "ollama" })).toBe(false);
	});
});
