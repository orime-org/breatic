// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * Why 300 seconds, and be precise about what it buys, because an earlier
 * version of this comment was not. Measured on Node 24, no deadline of our
 * own, a server that accepts the socket and then does nothing:
 *
 *   - waiting for a response:      rejected at 301.4s, HeadersTimeoutError
 *   - sending a body it never reads: rejected at 301.4s, same error
 *
 * So each of those stretches is already bounded at 300s by the platform, and
 * taking the same figure leaves the backend where it was rather than tightening
 * it. (The comment this replaced said both stretches "hang indefinitely",
 * citing a probe stopped at 90 seconds. The probe was real; the conclusion was
 * drawn 211 seconds too early.)
 *
 * What was NOT measured, stated plainly because a previous version of this
 * comment claimed more than it had: both figures come from a delivery that
 * spent all its time in ONE of the two stretches. A delivery that spends 200s
 * sending and then 200s waiting was never tried, so whether the platform would
 * allow 400s in total is unknown — and if it would, our timer is the one that
 * ends it. That gap is narrow in practice, because the callers with long
 * deliveries are precisely the ones that pass their own figure and never see
 * this default at all.
 *
 * Where the default does buy something is a browser, whose fetch has no
 * timeout of any kind. And what buys something everywhere is the caller's own
 * figure, which is usually far shorter than 300s and is the only one that can
 * be right for a particular call.
 *
 * SETTLED 2026-08-03. The figure it replaced was ten seconds, which was ours
 * rather than anyone's, and which cut an 8 MiB upload off mid-transfer three
 * times without it ever completing once — measured against a healthy server on
 * an ordinary uplink. That is the shape of the mistake to avoid repeating:
 * inventing a number on the caller's behalf.
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The largest deadline a timer can actually hold.
 *
 * `setTimeout` stores its delay in a signed 32-bit integer and does not refuse
 * anything outside that range — it silently rewrites it to ONE MILLISECOND,
 * with a warning on stderr and nothing else. Infinity, NaN, zero and negatives
 * get the same treatment. Measured against a healthy server answering in 50ms:
 * every one of those turned into three aborted deliveries and no response,
 * while 30_000 and nine hours both returned 200.
 *
 * A FRACTION is not one of these, and saying otherwise cost a real capability.
 * Measured on Node 24: 1500.75 fires at 1500ms and 300000.5 at 300011ms — the
 * delay is truncated, not rejected, and no warning is printed. Only 0.5 and
 * friends behave like zero, because that is what they truncate to.
 *
 * That matters because this layer ASKS callers to compute their own deadline,
 * and `size / rate` produces Infinity the moment a rate is misconfigured to
 * zero. So an out-of-range figure is refused at the boundary rather than
 * inverted into its opposite.
 *
 * (This constant existed before, was deleted when the timeout stopped being a
 * parameter, and comes back with it. Deleting it then was right — nothing
 * could reach it — and so is restoring it now.)
 */
export const MAX_TIMER_MS = 2_147_483_647;
