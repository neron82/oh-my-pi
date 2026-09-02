/**
 * Usage stat line — the second row rendered below the status bar, mirroring
 * the figures deepseek-harness shows under the chat window:
 *
 *   100 tok/s | Cache hit 99% | Input 46.8M tok · Output 194K tok
 *
 * Every number is measured, never copied from a layout example:
 *
 * - tok/s comes from live stream accounting (output tokens / stream time,
 *   aggregated across the main session and vibe workers),
 * - the cache-hit rate is provider-reported token usage
 *   (cacheRead / (cacheRead + cacheWrite + input) — the same honest
 *   denominator the `cache_hit` segment uses, where DeepSeek reports its
 *   cache miss as input),
 * - the totals are the session's cumulative input/output accounting.
 *
 * Pure presentation over {@link SegmentContext.usageStats}: this never
 * influences request construction and never invents numbers.
 *
 * Token counts use the compact "scaled" rule from deepseek-harness's
 * `formatTokens`: counts under one thousand stay exact, larger counts scale
 * to K/M with one decimal, and a scaled value of 100+ rounds to an integer
 * (46_842_394 → "46.8M", 194_392 → "194K").
 */

/** Session-usage totals (a structural subset of `SegmentContext.usageStats`). */
export interface UsageStatLineInput {
	/** Output tokens per second from the last live stream accounting; null before the first stream. */
	tokensPerSecond: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Compact token count for display, deepseek-harness style: 517 → "517",
 * 12_340 → "12.3K", 194_392 → "194K", 46_842_394 → "46.8M".
 */
export function formatCompactTokenCount(value: number): string {
	if (value < 1_000) return String(value);
	const scaled = (candidate: number): string =>
		candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
	if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
	return `${scaled(value / 1_000_000)}M`;
}

/** Stream speed for display: 100+ tok/s rounds to an integer, below stays at one decimal. */
export function formatTokensPerSecond(tokensPerSecond: number): string {
	return tokensPerSecond >= 100 ? String(Math.round(tokensPerSecond)) : tokensPerSecond.toFixed(1);
}

/**
 * Format the stat line from measured usage. `null` when nothing has been
 * recorded yet (no stream, no usage): the line stays off until there is a
 * real number to show. Parts with no measured data are omitted rather than
 * shown as placeholders.
 */
export function formatUsageStatLine(stats: UsageStatLineInput): string | null {
	const parts: string[] = [];

	if (stats.tokensPerSecond !== null && stats.tokensPerSecond > 0) {
		parts.push(`${formatTokensPerSecond(stats.tokensPerSecond)} tok/s`);
	}

	// Cache-hit rate from provider-reported tokens; cacheRead of 0 means the
	// provider reported no hits (or no cache stats at all), so omit the part.
	const cacheTotal = stats.cacheRead + stats.cacheWrite + stats.input;
	if (cacheTotal > 0 && stats.cacheRead > 0) {
		parts.push(`Cache hit ${Math.round((stats.cacheRead / cacheTotal) * 100)}%`);
	}

	if (stats.input > 0 || stats.output > 0) {
		parts.push(
			`Input ${formatCompactTokenCount(stats.input)} tok · Output ${formatCompactTokenCount(stats.output)} tok`,
		);
	}

	return parts.length > 0 ? parts.join(" | ") : null;
}
