import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import {
	formatCompactTokenCount,
	formatTokensPerSecond,
	formatUsageStatLine,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/usage-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

/** Component bound to real session-usage totals and a 100 tok/s assistant
 * stream (200 output tokens over an explicit 2s duration), for stat-line
 * pipeline tests. */
function makeUsageComponent(
	totals: { input: number; output: number; cacheRead: number; cacheWrite: number },
	options: { usageLine?: boolean },
): StatusLineComponent {
	const component = new StatusLineComponent({
		state: {
			messages: [{ role: "assistant", timestamp: 1, duration: 2_000, usage: { output: 200 } }],
			model: { id: "deepseek-chat", contextWindow: 100_000, provider: "deepseek" },
		},
		model: { id: "deepseek-chat", contextWindow: 100_000, provider: "deepseek" },
		sessionManager: {
			getUsageStatistics: () => ({
				...totals,
				totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		fetchUsageReports: async () => [],
		modelRegistry: {
			authStorage: { getOAuthAccountIdentity: () => undefined },
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: [],
		sessionAccent: false,
		usageLine: options.usageLine,
	});
	return component;
}

describe("formatCompactTokenCount", () => {
	it("keeps counts under one thousand exact", () => {
		expect(formatCompactTokenCount(0)).toBe("0");
		expect(formatCompactTokenCount(517)).toBe("517");
		expect(formatCompactTokenCount(999)).toBe("999");
	});

	it("scales to K and M with deepseek-harness's scaled rule (one decimal below 100, integer at 100+)", () => {
		expect(formatCompactTokenCount(1_000)).toBe("1K");
		expect(formatCompactTokenCount(1_234)).toBe("1.2K");
		expect(formatCompactTokenCount(194_392)).toBe("194K");
		expect(formatCompactTokenCount(46_842_394)).toBe("46.8M");
	});
});

describe("formatTokensPerSecond", () => {
	it("rounds high rates to integers and keeps one decimal below 100", () => {
		expect(formatTokensPerSecond(100)).toBe("100");
		expect(formatTokensPerSecond(97.34)).toBe("97.3");
		expect(formatTokensPerSecond(3)).toBe("3.0");
	});
});

describe("formatUsageStatLine", () => {
	it("renders measured tok/s, cache hit rate, and session totals like the reference layout", () => {
		// cacheRead makes the hit ratio ~99%: 4_637_397_006 / (4_637_397_006 + 46_842_394).
		const line = formatUsageStatLine({
			tokensPerSecond: 100,
			input: 46_842_394,
			output: 194_392,
			cacheRead: 4_637_397_006,
			cacheWrite: 0,
		});
		expect(line).toBe("100 tok/s | Cache hit 99% | Input 46.8M tok · Output 194K tok");
	});

	it("omits the speed part before the first stream and the cache part when no hits were reported", () => {
		expect(
			formatUsageStatLine({ tokensPerSecond: null, input: 1_000, output: 500, cacheRead: 2_000, cacheWrite: 0 }),
		).toBe("Cache hit 67% | Input 1K tok · Output 500 tok");
		expect(
			formatUsageStatLine({ tokensPerSecond: 12.3, input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0 }),
		).toBe("12.3 tok/s | Input 1K tok · Output 500 tok");
	});

	it("is null until any usage exists, so the row stays off on a fresh session", () => {
		expect(
			formatUsageStatLine({ tokensPerSecond: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		).toBeNull();
		expect(formatUsageStatLine({ tokensPerSecond: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
	});
});

describe("usage stat line (second row below the status bar)", () => {
	it("renders the second row below the standalone bar from the component pipeline", () => {
		const component = makeUsageComponent(
			{ input: 46_842_394, output: 194_392, cacheRead: 4_637_397_006, cacheWrite: 0 },
			{ usageLine: true },
		);

		// getPreviewLines runs the real bar pipeline (renderBottomBar →
		// #buildStatusLine), which recomputes the stat line from the same
		// usageStats the segments see.
		const lines = component
			.getPreviewLines(200, { bottomBar: "full", statusAttachment: "top-rule-chip" })
			.map(stripVTControlCharacters);

		expect(lines).toContain("100 tok/s | Cache hit 99% | Input 46.8M tok · Output 194K tok");
	});

	it("hides the second row when statusLine.usageLine is false", () => {
		const component = makeUsageComponent(
			{ input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0 },
			{ usageLine: false },
		);

		const lines = component
			.getPreviewLines(200, { bottomBar: "full", statusAttachment: "top-rule-chip" })
			.map(stripVTControlCharacters);

		expect(lines.some(line => line.includes("tok/s") || line.includes("Cache hit") || line.includes("Input "))).toBe(
			false,
		);
	});
});
