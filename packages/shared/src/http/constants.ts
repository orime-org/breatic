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
 * The rule for what belongs here: a figure this layer can answer for itself
 * stays here, and a figure only the caller can know is a parameter.
 *
 * "How many times may this be replayed" is the first kind. "How long may one
 * delivery take" is the second, and getting that wrong cost several days:
 * every call site sets it from something this layer cannot see — the model in
 * a vendor call, the size of the file being uploaded — so a fixed figure here
 * can only be this layer overruling the caller. What lives here is the
 * DEFAULT, for callers with no opinion.
 *
 * Anything about reading a response body is neither a figure nor a parameter
 * here — it is not this layer's business at all.
 */

/**
 * Retries AFTER the first attempt, so three deliveries at most.
 * Fixed by decision rather than exposed as a knob.
 */
export const MAX_RETRIES = 2;

/**
 * Base for the full-jittered exponential ceiling: `BASE_DELAY_MS * 2 **
 * (attempt - 1)`.
 *
 * It governs exactly one situation: the server named no wait we could read.
 * That is not the same as "not a 429" — ANY response carrying a usable
 * `Retry-After` is honoured, a 503 as readily as a 429, because the code asks
 * whether a figure arrived and not which status carried it. What is left for
 * this base is a dropped connection, a delivery that hit its deadline, and any
 * response whose header was absent or unreadable.
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
 * The deadline for one delivery when the caller names none.
 *
 * A DEFAULT, not a rule. How long a call may take is the caller's knowledge,
 * never this layer's: a vendor's timeout is set per model, an upload's is
 * computed from the file size, an internal endpoint should answer in a second.
 * This layer cannot derive any of that and must not try — it takes
 * `timeoutMs` and honours it. This figure only covers the callers that have no
 * opinion.
 *
 * Why a default has to exist at all: two stretches of a request can hang with
 * nobody watching — sending the body, and waiting for the answer. Connecting
 * is the operating system's; reading the response body is the caller's by an
 * earlier decision. Measured with no bound of our own, both hang indefinitely:
 * a fetch was still pending after 90 seconds against a server that accepted
 * the socket and then went quiet.
 *
 * Why 300 seconds: it is the platform's own answer, applied by the HTTP client
 * underneath both to waiting for a response and to the gap between body
 * chunks. Anyone who does not think about this gets what they already had.
 *
 * SETTLED 2026-08-03. The figure it replaced was ten seconds, which was ours
 * rather than anyone's, and which cut an 8 MiB upload off mid-transfer three
 * times without it ever completing once — measured against a healthy server on
 * an ordinary uplink. That is the shape of the mistake to avoid repeating:
 * inventing a number on the caller's behalf.
 */
export const DEFAULT_TIMEOUT_MS = 300_000;
