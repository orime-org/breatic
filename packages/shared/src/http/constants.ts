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
 * Ceiling on a server-directed `Retry-After`. Without a clamp, a mis-set
 * or hostile header ("Retry-After: 86400") would pin the caller for a day.
 */
export const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Default maximum silence between response-body chunks.
 *
 * Idle, not total: the clock resets on every chunk, so a slow 500 MB asset
 * download finishes while a connection that flushed headers and then went
 * quiet is cut. Fixed rather than configured for the same reason as the
 * retry count — "how long may a live connection send nothing" has one
 * defensible answer, and it does not vary by vendor the way first-response
 * latency does.
 *
 * 30s rather than the 300s that Node's own client defaults to: five minutes
 * of silence before anyone notices is far longer than this system needs to
 * tolerate, because a failure here is cheap — the transport replays, and a
 * worker job that does fail lands in the queue's own retry chain. Go and
 * python-requests ship no default at all, so there is no third precedent to
 * follow; this number is our judgement, not an industry constant.
 */
export const BODY_IDLE_TIMEOUT_MS = 30_000;
