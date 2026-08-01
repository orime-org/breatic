// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Fixed knobs of the shared HTTP transport.
 *
 * These are deliberately NOT configuration. The same numbers used to live in
 * separate yaml sections for the worker and the browser, and the two had
 * already drifted into different meanings: one counted retries after the first
 * attempt (so "3" was four deliveries) while the other counted total attempts
 * (so "3" was three). Both knobs are gone; one transport now gets one answer,
 * compiled in, and the two cannot disagree again.
 *
 * What genuinely varies by scenario — how long to wait for headers, polling
 * interval, total wait — stays a parameter, because a video generation and
 * a text lookup cannot share a timeout and a 2 GiB upload cannot share one
 * with a 100 KB one.
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
 * Maximum silence between response-body chunks.
 *
 * Idle, not total: the clock resets on every chunk, so a slow 500 MB asset
 * download finishes while a connection that flushed headers and then went
 * quiet is cut. Fixed rather than configured for the same reason as the
 * retry count — "how long may a live connection send nothing" has one
 * defensible answer, and it does not vary by vendor.
 *
 * 60s matches nginx's `proxy_read_timeout`, whose definition is this one
 * word for word: "set only between two successive read operations, not for
 * the transmission of the whole response". That is the closest thing to an
 * industry answer for this exact measurement, and it is the value the most
 * widely deployed reverse proxy applies by default.
 *
 * Breaching it FAILS the read; nothing is replayed. The retry loop covers the
 * headers phase only — by the time a body is being read the loop has already
 * returned its handle — so a caller that wants a stalled body retried has to
 * decide that for itself (decided 2026-08-01). An earlier version of this
 * comment justified a shorter deadline with "a failure here is cheap, the
 * transport replays", which was never true of this phase.
 */
export const BODY_IDLE_TIMEOUT_MS = 60_000;

/**
 * How much of a failing response body an error message may quote.
 *
 * The body of a non-ok response is peer-controlled and, for the callers that
 * choose their own URL, unbounded — `maxBodyBytes` is deliberately left unset
 * there. Quoting it whole produced multi-megabyte `Error` messages that went
 * straight to the application logger, carrying whatever the vendor echoed
 * back, including request material it had no business repeating.
 *
 * A thousand characters is enough to read a vendor's error JSON, which is
 * what this excerpt is for. Anything longer belongs in the response, not in
 * an exception.
 */
export const HTTP_ERROR_BODY_EXCERPT_CHARS = 1_000;

/**
 * How long an asset transfer may wait for response HEADERS.
 *
 * Shared by the two download paths — pulling a vendor's output into our own
 * storage, and pulling an asset back out for local processing — because they
 * are the same wait against the same class of endpoint. Reading the bytes is
 * governed by {@link BODY_IDLE_TIMEOUT_MS}, so this is not a total budget and
 * does not need to accommodate file size.
 *
 * Generous compared to a vendor API call: object stores can take a long
 * while to answer for a large object, and answering slowly is not a failure.
 *
 * It sits in this file even though the file's own rule is that per-attempt
 * timeouts stay PARAMETERS, because they genuinely differ between callers.
 * The exception is deliberate and narrow: this figure exists so the two asset
 * download paths cannot drift apart, which is the same reason the retry count
 * lives here. The rule it bends is "callers pick their own timeout"; the rule
 * it keeps is "one answer, in one place, when there should only be one".
 */
export const ASSET_HEADER_TIMEOUT_MS = 120_000;

/**
 * How many consecutive failed polls a task may survive.
 *
 * A vendor's status endpoint has a read-after-write window: the task id its
 * submit just returned is briefly not visible there, and the poll gets a 404.
 * The transport is right to refuse to replay that — for that one request it
 * is a genuine client error — but abandoning a generation the user already
 * paid for, over a gap that closes in under a second, is not.
 *
 * Two tolerated failures means three consecutive polls must fail before the
 * task is abandoned, which at any sane interval is several seconds of grace.
 * Bounded and consecutive on purpose: a vendor that is actually gone still
 * fails, and fails with what it said rather than a budget timeout.
 */
export const POLL_TRANSIENT_FAILURES_TOLERATED = 2;
