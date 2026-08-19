/**
 * Append-only context mode resolution.
 *
 * `auto` enables append-only context for every configured model, not only a
 * per-provider allowlist. Rationale (prompt-cache stability):
 *
 * - A byte-stable request prefix is a strict superset of what any
 *   provider-side prefix/KV cache needs: content-based server caches
 *   (Anthropic, OpenAI, Google) hit maximally on identical leading bytes, and
 *   provider-session replay protocols are unaffected by client-side byte
 *   stability.
 * - For KV-retaining local inference engines (llama.cpp-style prefix KV
 *   reuse), append-only mode is the *only* guarantee of stable leading bytes,
 *   because the live system prompt, tool catalogue, and message log otherwise
 *   flow through fresh allocations every step.
 * - One uniform execution model means the same session behavior — and the
 *   same cache observability — applies to every provider, instead of a
 *   per-provider fork whose boundary silently decides how stable a session
 *   is.
 *
 * `off` remains the escape hatch for workflows where the snapshot cost
 * outweighs the benefit.
 */
export interface AppendOnlyContextModel {
	provider: string;
}

/** Resolves whether append-only context should be active for a model and setting. */
export function shouldEnableAppendOnlyContext(
	setting: "auto" | "on" | "off" | undefined,
	model: AppendOnlyContextModel | null | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			// Auto: on for any configured model (see module docs).
			return model != null;
	}
}
