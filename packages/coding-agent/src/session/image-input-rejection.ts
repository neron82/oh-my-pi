/**
 * Runtime correction for a local backend that rejects image input.
 *
 * A local engine serves the whole request in one process, so a failure caused
 * by the *content* of the prompt surfaces as a server error mid-decode instead
 * of a request validation rejection — and it is perfectly deterministic. The
 * canonical case is llama.cpp: its speculative-decoding draft path skips a
 * prompt's pinned M-RoPE image chunk, leaving the draft context with a position
 * gap that `llama_decode(ctx_dft)` then refuses, so *every* request carrying an
 * image dies with HTTP 500 `failed to process speculative batch` — including
 * the ones a replay re-sends unchanged. Retrying the identical request burns
 * the retry budget, poisons the backend's slot prompt cache a little more on
 * each attempt, and ends the turn with the user's images still queued.
 *
 * The correction is therefore made *before* the retry: once a local backend has
 * demonstrably died on a request carrying images, the session model's declared
 * image capability is withdrawn for the rest of the session. Every layer that
 * gates image content reads that capability, so one correction stops the wire
 * from carrying images (the outbound scrub in `sdk.ts`, `sendsImageInputOnWire`
 * in the vision guard), keeps `snapcompact` from attaching bitmap frames it
 * would otherwise see silently dropped, and lets the vision-description
 * fallback take over for attachments. History keeps its images: switching to a
 * backend that accepts them restores vision for the resend.
 *
 * Scope is deliberately local-only. A hosted provider 5xx is a transient
 * capacity event, and withdrawing image input there would silently drop what
 * the user attached instead of surfacing the failure.
 */

import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isLocalServingBackend } from "@oh-my-pi/pi-catalog/compat/resolve";

/** Server-side failure floor: 4xx is a request verdict, not a mid-decode death. */
const SERVER_ERROR_STATUS = 500;

/**
 * Whether `message` is a local backend failing a turn that carried images, for
 * a model that still claims image input. Callers pair this with a check that
 * the context actually carries images — this predicate only owns the failure's
 * attribution to the backend.
 *
 * Context overflow is excluded: it is compaction's remedy, and a local engine
 * can report it with a 5xx that has nothing to do with the prompt's images.
 */
export function isImageInputRejection(model: Model | undefined, message: AssistantMessage): boolean {
	if (!model || !model.input.includes("image")) return false;
	if (message.stopReason !== "error") return false;
	const status = message.errorStatus;
	if (status === undefined || status < SERVER_ERROR_STATUS) return false;
	if (AIError.is(message.errorId, AIError.Flag.ContextOverflow)) return false;
	return isLocalServingBackend({ provider: model.provider, baseUrl: model.baseUrl });
}

/**
 * `model` with image input withdrawn. The declared capability is the single
 * input every image gate reads, so correcting it here — rather than threading a
 * separate "images are broken" flag through the request path — is what keeps
 * the wire, the compaction frame budget, and the attachment fallback
 * consistent.
 */
export function withoutImageInput(model: Model): Model {
	return { ...model, input: model.input.filter(capability => capability !== "image") };
}
