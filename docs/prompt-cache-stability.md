# Prompt & KV-Cache Stability in OMP

This document explains how OMP constructs model requests, what was learned from the
deepseek-harness reference implementation, which ideas were adopted (and which were
deliberately not), and how prefix stability is measured.

Status: final — benchmark results in section 10.

## 1. What makes deepseek-harness cache-efficient

deepseek-harness is an event-sourced harness whose execution model is built around
preserving the longest possible stable prompt prefix. The load-bearing ideas:

1. **Append-only event log with surface projection.** All session state is an
   ordered log of immutable, deep-frozen events. Only a small set of event kinds
   produce LLM messages ("surface" projection). Appends are O(1) and never rewrite
   earlier bytes; a replacement is an explicit, counted operation that is the *only*
   thing allowed to invalidate the derived-message cache.
2. **Epoch headers.** Config + system prompt + tools travel as a full canonical
   snapshot ("request header"). A new header is recorded only when a strict
   equality check fails. The live request invariant is: request == header + derived
   messages, verified on every `llm/stream` call.
3. **Deterministic tool ordering & stable schema shape.** Tool order is either
   explicit config or locale-independent code-unit lexicographic — "registration
   order is a concurrent loading artifact and must not leak downstream." Tool
   schemas are projected to exactly `{name, description, parameters}` with stable
   key insertion; no re-canonicalization between builds.
4. **Dynamic data kept out of the prefix.** Runtime context (instructions, sandbox
   state, approvals) is rendered into a single user-role snapshot appended at the
   *tail*, only when its rendered text changes. Timestamps are opt-in throttled tail
   messages. Todo state is log-only and never derived into the prompt.
5. **KV-cache-aligned compaction.** The summarization call replays the
   conversation's *own* system prompt + tool schemas + the shadowed region messages
   verbatim, with the compaction instruction appended as the final user message.
   The summarize request is therefore a genuine prefix extension of the last routed
   request: only the instruction and the summary output are uncached.
6. **Measurement as an invariant.** `expectPrefixExtension` asserts in tests that
   every request's messages are a strict value-prefix of the previous one with
   identical system + tools; property tests pin derivation determinism; a key-gated
   e2e asserts the provider reports `cacheReadTokens > 0` on every request after the
   first.

## 2. What OMP already had

OMP already solved several of these problems incrementally (issues #7404, #3406,
#6625, #7139):

- `AppendOnlyContextManager` (`packages/agent/src/append-only-context.ts`):
  `StablePrefix` (frozen system prompt + tools snapshot, rebuilt only when a
  fingerprint changes) + `AppendOnlyLog` (append-only message log; `syncMessages`
  trims to the longest byte-stable prefix on in-place rewrites and re-appends the
  diverged tail) — the OMP analogue of deepseek's surface projection.
- Date/cwd moved *out* of the system prompt into a per-request first-user-message
  reminder (`session/date-cwd-reminder.ts`), memoized on message identity so the
  append-only path keeps bytes stable.
- Position-independent steering wrap (`wrapSteeringForModel`) so a steering message
  is sent byte-identically whether it sits at the tail or is buried in history.
- Tool-signature tracking (`session-tools.ts`) that forces a system-prompt rebuild
  only when the applied tool set actually changed.
- End-to-end cache-token accounting (`Usage.cacheRead` / `cacheWrite`, OTEL
  `gen_ai.usage.cache_*`).
- KV-aligned *handoff* generation (`generateHandoffFromContext` passes the live
  system prompt + tools verbatim).

## 3. Instability sources found in the audit

| # | Source | Effect | Resolution |
|---|--------|--------|------------|
| 1 | Append-only mode `auto` resolves OFF for server-side prefix-cache providers (Anthropic, OpenAI, …) | Whole `Context` rebuilt fresh every turn; byte-stability of system/tools/messages is only accidental | `auto` now defaults ON for all providers; `off` remains an escape hatch |
| 2 | Skill list in the system prompt rendered in directory-scan order | A system-prompt rebuild (tool change, extension reload) could reorder skills and silently invalidate the prefix | Skills rendered in deterministic (name, then source) order |
| 3 | Compaction summarization uses `SUMMARIZATION_SYSTEM_PROMPT` + a *text-serialized* `<conversation>` blob | The summarize request shares essentially no prefix bytes with the live request → full re-prefill of the whole shadowed region on local engines | KV-aligned summarization: replay the session's own system prompt + tools + verbatim region messages, append the instruction as the final user message (text mode retained for remote-endpoint compaction) |
| 4 | No prefix-stability observability anywhere | "Why did this request lose its cache hit?" is unanswerable | `PromptStabilityMonitor` per agent + debug log, session dump section, TUI info line, OTEL attributes |
| 5 | Tool schema serialization not provably byte-stable across rebuilds | Re-instantiated tools (MCP reconnect) *could* differ in schema key order | Verified deterministic (memoized wire schemas, pure `normalizeTools`); new tools append after the existing order; pinned by tests |
| 6 | Date/cwd in system prompt | — | Already fixed (#7404); test retained |
| 7 | Steering re-wrap on burial | — | Already fixed; test retained |

## 4. Concepts adopted

- **Default-on append-only execution** (idea 1+2): the append-only log + stable
  prefix is now the default request path for every provider, because byte-stable
  requests are a strict superset of what server-side prefix caching needs and are
  the only guarantee for local inference engines.
- **KV-aligned compaction summarization** (idea 5), built on the monitor's record
  of the last live request prefix (the "epoch header").
- **Deterministic tool/skill ordering + byte-stability tests** (idea 3).
- **Prefix-extension invariant in tests** (idea 6): consecutive unchanged
  configuration ⇒ request N+1's serialization is a strict prefix extension of
  request N's.
- **Dynamic data at the tail** (idea 4): already true for date/cwd and steering;
  advisor feedback enters as a new appended custom-message card, never by
  regenerating earlier sections.

## 5. Concepts deliberately NOT adopted

- **deepseek's event schema & Cordis plugin framework.** OMP's session entries
  (`session.jsonl`) + `AgentMessage` flow + extension system are the equivalent
  substrate and are deeply integrated with session handling, rewind, branching and
  the TUI. Porting the event schema would be a mechanical rewrite with no
  cache-behavior payoff. The *principle* (append-only, immutable, projection
  produces the prompt) is what was kept.
- **Provider `cache_control` markers / breakpoint management.** OMP stays
  provider-agnostic; stability is structural, not managed. Providers that expose
  breakpoints (Anthropic) get stable breakpoints for free because the bytes are
  stable.
- **Deep-frozen request objects.** OMP's transforms (obfuscation, snapcompact,
  steering wrap) legitimately re-derive contexts each turn; the digest-based
  longest-stable-prefix sync in `AppendOnlyContextManager` handles in-place rewrites
  that a frozen-object model would reject.
- **DeepSeek-specific message conventions.** No provider-specific framing is
  hardcoded into generic paths.

## 6. Resulting prompt lifecycle

```
session start
  system prompt built once; tools normalized; first request snapshots StablePrefix;
  monitor records request #1 (baseline).

normal turn
  user/assistant/tool messages APPEND to the append-only log;
  request N+1 = byte-identical prefix of request N + new tail;
  monitor: stablePrefix == previous total, cause "appended".

advisor activity
  advisor agents are independent agents (own model, tools, own monitor);
  advice enters the worker trajectory as a new appended custom-message card;
  the worker's system prompt and earlier messages are untouched.

tool-set change / extension system-prompt change
  legitimate prefix invalidation from the system section; monitor attributes
  cause "system-prompt-changed" / "tool-set-changed"; new tools append after the
  existing order so the tool-array prefix stays stable when the set grows.

model / provider switch
  invalidateForModelChange() → full prefix rebuild; monitor attributes
  "model-switch".

compaction
  summarization request = live system prompt + live tools + verbatim shadowed
  region + trailing instruction (prefix extension of the last live request);
  post-compaction request starts a new prefix epoch; monitor flags "compaction".
```

Correctness never depends on caching: with caching disabled or unavailable the
same requests are simply fully prefilled.

## 7. How prefix stability is maintained (invariants)

1. The system prompt is a frozen snapshot until its inputs (tools, extensions,
   cwd-scoped discovery) change; changes rebuild the whole section deliberately.
2. Tool specs are pure functions of the tool registry: memoized wire-schema
   conversion + order-preserving `normalizeTools`; growing the tool set appends.
3. Messages enter the wire path only by append; in-place rewrites are reconciled
   by longest-stable-prefix sync (cache stays warm to the divergence point).
4. Everything that changes per request (date/cwd) rides on the first user message
   via an identity-memoized transform, outside the system prompt and tool array.
5. Compaction is boundary-anchored and KV-aligned (section 4).

## 8. Inspecting cache behavior

- **Debug log:** every model request logs a one-line prompt-stability report
  (`logger.debug`, `prompt-stability` category): total bytes, stable-prefix bytes,
  first divergence point, invalidation cause, estimated vs actual cache-hit ratio.
- **TUI:** the status line's `cache_hit` segment shows the provider-reported
  cache-hit rate, and a second measured-usage line renders below the bar
  (`statusLine.usageLine`, default on): live token speed, cache-hit rate, and
  cumulative session input/output — e.g.
  `100 tok/s | Cache hit 99% | Input 46.8M tok · Output 194K tok`, computed
  from the same real usage accounting described here, not the monitor's
  byte estimate.
- **Session dump:** `formatSessionDumpText` gains a `prompt-cache` section with
  the per-request reports for the current run.
- **OTEL:** chat spans carry `pi.prompt_stability.*` attributes (stable-prefix
  bytes, first divergence, cause flags, estimated ratio) alongside the existing
  `gen_ai.usage.cache_read.input_tokens`.
- **API:** `agent.stabilityMonitor.last()` / `.history(n)` for programmatic access
  (used by tests and the benchmark).
- Where the provider reports `cacheRead`/`cacheWrite` tokens, the monitor merges
  them into an *actual* cache-hit ratio; otherwise a deterministic local estimate
  (stable-prefix bytes / total bytes of the serialized request) is reported.

## 9. Benchmark

`packages/coding-agent/scripts/prompt-cache-benchmark.ts` drives a deterministic
multi-turn coding trajectory (tool calls + realistic tool results) through a real
`AgentSession` with a scripted mock model, in two configurations (legacy
non-append-only vs new default), and reports per-turn serialized prompt length,
reusable prefix length, reuse percentage, unnecessary invalidations, and
full-prefix rebuilds. Results: see section 10.

## 10. Benchmark results

`bun packages/coding-agent/scripts/prompt-cache-benchmark.ts` (add `--json` for
machine output). The trajectory is a 3-turn coding task (fix an off-by-one bug,
add a test, summarize) → 6 model calls with 3 real tool executions (`read`,
2× `write`) against a throwaway fixture repo; 11 real tools in the registry;
no network, scripted mock model.

Measured (identical fixture layout, model, and settings except the
configuration under test; each run gets its own fresh temp working
directory, so the cwd value — which rides in the first user message —
differs per run at equal length):

| Request | Turn | Total | Stable prefix | Reuse | Divergence | Cause |
|---|---|---|---|---|---|---|
| 1 | T1 | 57.3KB | baseline | — | first-request | first-request |
| 2 | T1 | 57.7KB | 57.3KB | 99.2% | appended | appended |
| 3 | T1 | 58.2KB | 57.7KB | 99.2% | appended | appended |
| 4 | T2 | 58.5KB | 58.2KB | 99.5% | appended | appended |
| 5 | T2 | 59.1KB | 58.5KB | 99.0% | appended | appended |
| 6 | T3 | 59.4KB | 59.1KB | 99.5% | appended | appended |

| Metric | legacy (`off`) | new default (`auto` → ON) |
|---|---|---|
| avg reuse (requests 2+) | 99.3% | 99.3% |
| full-prefix rebuilds | 0 | 0 |
| prefix invalidations (non-append) | 0 | 0 |
| total prompt bytes (sum over 6 requests) | 358,606 | 358,606 |
| bytes a KV-retaining engine could skip re-prefilling | 297,753 (83.0%) | 297,753 (83.0%) |
| stability-monitor cross-check | matched | matched |

Reading the result:

- Every request from #2 on is a **strict byte-prefix extension** of the
  previous one (`cause: appended`, first divergence at the message boundary,
  never inside system or tools). The entire first request (57.3KB: 19.6KB
  system + 38.7KB tools) is reusable from cache on every later request.
- The measured sizes are identical across configurations (equal-length temp
  paths keep the byte totals aligned) because the deterministic-construction
  fixes (section 3) make fresh rebuilds byte-stable **within a run**; the
  only bytes that differ between the two runs are the per-run cwd values.
  The `legacy` row is the pre-change **execution mode** (no append-only
  pinning): its stability is accidental — it holds only because every prompt
  source currently happens to be deterministic. The `new` row's stability is
  **structural**: the append-only manager pins the stable-prefix bytes, so a
  future regression in any prompt source (or an extension rewriting earlier
  messages) degrades to "prefix warm to the divergence point" instead of a
  full invalidation. That is the guarantee the pre-change code did not have —
  and it is the only guarantee for KV-retaining local engines.
- The independent LCP accounting in the script matches the in-loop stability
  monitor on every request for both configurations (`monitor cross-check:
  matched`), validating the observability numbers in section 8.
- "Unnecessary invalidations" and "full-prefix rebuilds" are both zero; there
  is no request in the trajectory that loses cache reuse it should have kept.
