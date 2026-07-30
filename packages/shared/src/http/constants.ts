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
 * What genuinely varies by scenario — per-attempt timeout, polling
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
 * Every HTTP verb, handed to the underlying client so that its own
 * method whitelist stops gating our predicate.
 *
 * The client treats `methods` as a gate IN FRONT OF its retry hook — a
 * verb outside the list is never even offered to the hook (measured, see
 * `engineering/demo/2026-07-30-ky-retry-behaviour-probe-round3.mjs` check
 * C1). Since this transport keys on the caller's `replaySafe` fact rather
 * than on the verb, that gate has to be held open or a POST carrying a
 * vendor idempotency key could never be replayed.
 */
export const ALL_HTTP_METHODS: readonly string[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
];
