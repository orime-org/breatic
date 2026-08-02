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
 * How long a server may ask us to wait before the wait stops being worth
 * having.
 *
 * A threshold, not a clamp. Past it the request stops and the response the
 * server sent — `Retry-After` header and all — goes back to the caller, which
 * can read the figure and decide for itself. Clamping, which this used to do,
 * was the worst available option: a server asking for 30s got silently
 * rewritten to 10s, so we neither did what it asked nor spared anyone the
 * wait, and the 10s was a number nobody had sent.
 *
 * One figure rather than two. There was a second, shorter bound for callers
 * with a person waiting, justified by Nielsen's attention limit — but "how
 * long is a person willing to wait" is a product decision, and this layer does
 * not hold product decisions. The caller that cares can read the header and
 * act on it; this bound exists only so one call cannot occupy a caller for an
 * unbounded stretch.
 *
 * 60 seconds matches Stripe's `MAX_RETRY_AFTER_WAIT` (src/RequestSender.ts),
 * the same bound applied for the same reason in a payments SDK. Where we
 * differ, deliberately: past the bound Stripe ignores the header and falls
 * back to its own backoff, whereas we stop. Substituting our own number for
 * the server's is exactly the guess this design refuses to make.
 */
export const MAX_RETRY_AFTER_MS = 60_000;


/**
 * How long one delivery may wait FOR RESPONSE HEADERS.
 *
 * Fixed rather than asked of the caller. Every call site that ever set this
 * was setting it from config or from a literal, and none of them knew anything
 * this layer does not — "how long until a server is not going to answer" is a
 * property of the network, not of what the caller happens to be fetching.
 *
 * Ten seconds is the figure the product owner settled on for waiting on
 * headers (2026-08-01). The deadline ends when the headers arrive; what
 * happens while the body is read is not this layer's business, and the client
 * underneath already times a stalled read.
 */
export const HEADERS_TIMEOUT_MS = 10_000;

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
