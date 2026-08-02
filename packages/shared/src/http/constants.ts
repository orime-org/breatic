// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Fixed figures of the shared HTTP transport.
 *
 * These are deliberately NOT configuration. The retry count lived in separate
 * yaml sections for the worker and the browser, and the two had already
 * drifted into different MEANINGS: one counted retries after the first attempt
 * (so "3" was four deliveries) while the other counted total attempts (so "3"
 * was three). One transport gets one answer, compiled in, and two places
 * cannot disagree about it again.
 *
 * The rule for what belongs here: a figure that has one defensible answer
 * belongs in this file, and a figure that genuinely differs between callers
 * stays a parameter. "How many times may this be replayed" has one answer.
 * "How long may one attempt wait for response headers" does not — a vendor
 * API and an object store differ by an order of magnitude — so it is a
 * parameter. Anything about reading a body is neither: it is not this
 * layer's at all.
 */

/**
 * Retries AFTER the first attempt, so three deliveries at most.
 * Fixed by decision rather than exposed as a knob.
 */
export const MAX_RETRIES = 2;

/**
 * Base for the full-jittered exponential ceiling: `BASE_DELAY_MS * 2 **
 * (attempt - 1)`. A rate-limited response that carries `Retry-After` uses
 * the server's number instead; this base only governs the cases where the
 * server told us nothing (5xx, dropped connection, attempt timeout).
 */
export const BASE_DELAY_MS = 1000;

/**
 * How long a server may ask an INTERACTIVE caller to wait before the wait
 * stops being worth having.
 *
 * A threshold, not a clamp. Past it the request fails and the number the
 * server asked for goes back to the caller, so it can say what happened and
 * let the person decide when to try again. Clamping — which is what this
 * used to do — was the worst available option: a server asking for 30s got
 * silently rewritten to 10s, so we neither did what it asked nor spared the
 * person waiting, and the 10s was a number nobody had sent.
 *
 * 10 seconds is Nielsen's third response-time limit: about the longest a
 * user's attention stays on a task before they go and do something else
 * (https://www.nngroup.com/articles/response-times-3-important-limits/).
 * A wait past that has already lost them, so failing outright and letting
 * them choose beats holding them there.
 */
export const MAX_RETRY_AFTER_INTERACTIVE_MS = 10_000;

/**
 * The same threshold for a caller with nobody waiting on it — a worker
 * calling a vendor. The vendor knows its own recovery timeline, and there is
 * no attention to lose, so its number wins over a much wider range.
 *
 * 60 seconds matches Stripe's `MAX_RETRY_AFTER_WAIT` (src/RequestSender.ts),
 * which is the same bound applied for the same reason in a payments SDK.
 * Where we differ, deliberately: past the bound Stripe ignores the header and
 * falls back to its own backoff, whereas we fail. Substituting our own number
 * for the server's is exactly the guess this design refuses to make, and we
 * have no queue to defer the work to — every operation ends as completed or
 * failed, so "failed, and here is what the server said" is the honest outcome.
 */
export const MAX_RETRY_AFTER_BACKGROUND_MS = 60_000;





/**
 * The largest delay a timer can actually hold.
 *
 * `setTimeout` stores its delay in a signed 32-bit integer and CLAMPS anything
 * larger to one millisecond — with a warning on stderr and nothing else. So a
 * caller granting a 30-day deadline got the exact opposite: an attempt that
 * aborted almost immediately, was classified as a timeout, and was replayed.
 * A value past this bound is refused rather than accepted and inverted.
 */
export const MAX_TIMER_MS = 2_147_483_647;
