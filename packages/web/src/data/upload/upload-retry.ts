// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Browser upload resilience (asset slice 2, #1609; closes resilience gap ⑤).
 *
 * The two halves of an upload are resilient in different ways. **The ticket
 * request** talks to our own backend through the axios client, and
 * {@link retryTransient} is what gives it its 3 attempts and full-jittered
 * backoff; its knobs come from `GET /assets/upload-config`
 * (config/storage.yaml `upload:` section), session-cached by the caller.
 * **The parts** go to the ingest Worker through the shared HTTP transport,
 * which owns how many times each one is delivered.
 *
 * The two do not even judge "transient" the same way. The ticket request keeps
 * the reading below: 5xx, 429, and a network-level failure, with a 4xx taken
 * as a fact rather than weather. The transport reads the protocol instead,
 * retrying 408 and 429 despite both being 4xx.
 *
 * The transport would also honour `Retry-After`, and the Worker never sends
 * one, so it falls back to its own backoff — the same three deliveries either
 * way.
 */

import { partDeadlineMs } from '@breatic/shared';

/** The upload knobs served by `GET /assets/upload-config` (camelCase wire). */
export interface UploadClientConfig {
  /** Hard upload cap in bytes (pre-checked on selection; server 413s). */
  maxUploadBytes: number;
  /** Presign attempts including the first; the PUT's count lives in the transport. */
  clientMaxAttempts: number;
  /** Base backoff (ms) between ticket attempts; full jitter on base * 2^attemptIndex. */
  clientRetryBaseDelayMs: number;
  /** Floor for the part stall guard. It times no API request — the ticket goes through the axios client. */
  clientRequestTimeoutMs: number;
  /** PUT stall guard rate: timeout = max(floor, size / rate). */
  clientPutMinBytesPerSec: number;
}

/** An HTTP failure from the storage PUT, carrying the response status. */
export class UploadHttpError extends Error {
  /** The HTTP response status. */
  readonly status: number;

  /**
   * Build the error from the PUT response status.
   * @param status - The non-2xx HTTP status the PUT target responded with.
   */
  constructor(status: number) {
    super(`Asset upload failed (HTTP ${status})`);
    this.name = 'UploadHttpError';
    this.status = status;
  }
}

/** The account is out of storage (RFC 4918 §11.5) — nothing a retry can fix. */
export const STORAGE_FULL_STATUS = 507;

/**
 * Extract an HTTP status from a ticket failure, if it carries one.
 *
 * Exported because two questions are asked of the same answer and they must
 * not drift: whether to retry (below) and, in the canvas upload pipeline,
 * which failure to tell the user about.
 *
 * One shape reaches this now: the project's `ApiException`, whose status is
 * FLAT on `.status` and NOT at `{response:{status}}`. Reading only the axios
 * shape once left ticket retries dead, which is why the flat read exists.
 *
 * The raw axios shape used to be read here as a fallback and no longer is, on
 * the same ground that removed two branches from the predicate below: apiGet's
 * interceptor turns every failure into an ApiException before anything here
 * sees it, so a raw axios error cannot arrive. Keeping one unreachable branch
 * while deleting two others would have been half a judgment.
 * @param err - The thrown value.
 * @returns The status, or null when the error carries none (network-level).
 */
export function errorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const flat = (err as { status?: unknown }).status;
  if (typeof flat === 'number') return flat;
  return null;
}

/**
 * Whether a ticket failure is transient (worth retrying): 5xx other than
 * 507, 429, and network-level failures, which apiGet reports as status 0.
 * Other 4xx, 507, and unknown programming errors are final — see the 507
 * carve-out in the body for why a full account is not a server hiccup.
 *
 * It once also recognised a bare `TypeError` and an `AbortError` /
 * `TimeoutError` — the shapes raw `fetch` throws. Those were for the PUT,
 * which now retries inside the shared transport, and the only caller left is
 * the ticket request: it goes through axios, whose interceptor turns every failure into
 * an `ApiException` before this ever sees it. So neither shape can arrive
 * here, and a judgment nobody can reach is worse than no judgment.
 * @param err - The thrown value.
 * @returns True when a retry could plausibly succeed.
 */
export function isTransientUploadError(err: unknown): boolean {
  const status = errorStatus(err);
  // 507 is the one 5xx that says nothing about the server: the account is out
  // of storage (#89), and nobody frees any in the seconds a retry takes. Left
  // in the band below, a refused upload would ask three more times and then
  // report a generic failure — burying the one sentence that could be acted
  // on, which arrived with the first answer.
  if (status === STORAGE_FULL_STATUS) return false;
  // status 0 = no HTTP response reached us (network drop / timeout / CORS),
  // which apiGet normalizes to `.status = 0` — the most retryable case.
  if (status !== null) return status === 0 || status >= 500 || status === 429;
  return false;
}

/** Injectable knobs for {@link retryTransient} (tests avoid real timers). */
export interface RetryOptions {
  /** Total attempts including the first. */
  attempts: number;
  /** Base backoff in ms (full jitter on base * 2^attemptIndex). */
  baseDelayMs: number;
  /** Sleep implementation (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Uniform [0,1) source for the jitter (default: Math.random). */
  random?: () => number;
}

/**
 * Run an async operation with bounded retries on transient failures,
 * full-jittered exponential backoff between attempts.
 * @param fn - The operation; receives the 0-based attempt index.
 * @param opts - Attempt budget + backoff knobs.
 * @returns The first successful result.
 * @throws {unknown} The last error once attempts are exhausted, or the
 *   first non-transient error immediately.
 */
export async function retryTransient<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: unknown) {
      lastError = err;
      const isLast = attempt === opts.attempts - 1;
      if (isLast || !isTransientUploadError(err)) throw err;
      await sleep(random() * opts.baseDelayMs * 2 ** attempt);
    }
  }
  // Unreachable: the loop always returns or throws. Kept for TS narrowing.
  throw lastError;
}

/**
 * Per-attempt PUT timeout: a stall guard, not a UX deadline. Scales with
 * file size at the minimum acceptable transfer rate so a legitimately
 * slow big upload never trips it, floored at the value below, whose name says API request but times none.
 * @param sizeBytes - The file size about to be PUT.
 * @param cfg - The upload knobs.
 * @returns The per-attempt timeout in milliseconds.
 */
export function computePutTimeoutMs(
  sizeBytes: number,
  cfg: UploadClientConfig,
): number {
  // The same arithmetic the config reads when it checks that the Durable
  // Object's idle window outlasts a part's whole delivery. A second copy here
  // would let the browser's deadline and that check disagree.
  return partDeadlineMs(sizeBytes, {
    requestTimeoutMs: cfg.clientRequestTimeoutMs,
    minBytesPerSec: cfg.clientPutMinBytesPerSec,
  });
}
