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
 * The rule for what belongs here: this layer asks the caller for ONE thing —
 * whether replaying costs anything — and answers everything else for itself,
 * so every figure it needs is in this file. There are no parameters left for
 * a figure to become.
 *
 * That includes how long one delivery may take. Every call site that ever set
 * it read it from config or from a literal, and none of them knew anything
 * this layer does not — which is exactly why it belongs here: writing the same
 * timeout at every call site is the duplication this layer exists to remove.
 * Anything about reading a body is neither a figure nor a parameter here — it
 * is not this layer's business at all.
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
 * How long ONE delivery may take in total — sending the request included.
 *
 * Named for what it does: the only lever here is an abort signal, and aborting
 * ends the whole operation, upload and wait alike. One figure, both phases.
 *
 * 300 seconds is the platform's own answer — the HTTP client underneath
 * applies exactly this figure to waiting for a response and to the gap between
 * body chunks. Taking the same number means no request that works today stops
 * working.
 *
 * It replaced ten seconds, which was ours rather than anyone's, and which cut
 * an 8 MiB upload off mid-transfer three times without it ever completing
 * once — measured against a healthy server on an ordinary uplink.
 *
 * SETTLED 2026-08-03, and settled means settled. The reasoning, in full, so
 * that nobody has to reopen it:
 *
 *   - Two stretches of a request can hang with nobody watching: sending the
 *     body, and waiting for the answer. (Connecting is the operating system's;
 *     reading the body is the caller's by an earlier decision.) Measured with
 *     no bound of our own, both hang indefinitely — a fetch was still pending
 *     after 90 seconds against a server that accepted the socket and went
 *     quiet.
 *   - Those two stretches want different answers. "How long should sending
 *     take" is size divided by bandwidth and has no single answer; "how long
 *     until a silent server counts as dead" does.
 *   - One abort signal is all this API offers, in Node and in a browser alike,
 *     and it ends the whole operation. So one figure has to cover both, and
 *     the only defensible one is the platform's.
 *
 * There is no test driving a real delivery to this deadline: three of them
 * would be a fifteen-minute suite, and faking the clock to avoid that broke
 * the real socket underneath (measured: the request never left). What guards
 * the figure instead is real-fetch.test.ts's upload case, which takes ~16
 * seconds of real time and fails the moment this is shortened past it.
 */
export const DELIVERY_TIMEOUT_MS = 300_000;
