// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Browser upload resilience (asset slice 2, #1609; closes resilience gap ⑤).
 *
 * presign and PUT both retry on transient failures with full-jittered
 * exponential backoff and a per-attempt timeout, so a dead connection aborts
 * and retries instead of hanging forever. Only transient failures retry — a
 * 4xx is a fact, not weather.
 *
 * The verdict on what counts as transient, the attempt budget and the backoff
 * all come from `@breatic/shared`, the same code the backend runs. They used to
 * live here as a separate opinion, which had already drifted: the browser
 * retried 5xx while the worker's HTTP layer retried only 429. Timeouts still
 * come from `GET /assets/upload-config` (`config/storage.yaml`) because they
 * genuinely differ — the PUT stall guard scales with file size.
 */

import { decideRetry, httpRequest } from '@breatic/shared';
import type { TransportErrorKind } from '@breatic/shared';

/**
 * The upload knobs served by `GET /assets/upload-config` (camelCase wire).
 *
 * Attempt count and backoff base are deliberately absent: they are fixed
 * inside the shared HTTP transport, so the browser and the backend cannot
 * disagree about how many tries an upload gets.
 */
export interface UploadClientConfig {
  /** Hard upload cap in bytes (pre-checked on selection; server 413s). */
  maxUploadBytes: number;
  /** Per-attempt API request timeout (ms); also the PUT timeout floor. */
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

/**
 * Extract an HTTP status from an upload/presign error, if it carries one.
 * Covers three shapes: {@link UploadHttpError} (PUT path), the project's
 * `ApiException` (apiGet path — a FLAT `.status`, NOT `{response:{status}}`),
 * and a raw axios error (`{ response: { status } }`, defensive fallback).
 * The flat-status branch is what makes the presign retry actually work —
 * apiGet normalizes every failure into an ApiException whose status lives
 * on `.status`, so reading only the axios shape left presign retries dead.
 * @param err - The thrown value.
 * @returns The status, or null when the error carries none (network-level).
 */
function errorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const flat = (err as { status?: unknown }).status;
  if (typeof flat === 'number') return flat;
  const nested = (err as { response?: { status?: unknown } }).response?.status;
  if (typeof nested === 'number') return nested;
  return null;
}

/**
 * Translate a browser-side failure into the shared judgement's vocabulary.
 *
 * `apiGet` normalizes "no response reached us" to `.status = 0`, which is not
 * an HTTP status — it has to be reported as a transport failure or the shared
 * predicate would read it as an impossible status code and refuse the retry.
 * @param err - The thrown value.
 * @param status - The status extracted by {@link errorStatus}, if any.
 * @returns The transport-error kind, or undefined when a real response arrived.
 */
function transportKind(
  err: unknown,
  status: number | null,
): TransportErrorKind | undefined {
  if (status !== null && status !== 0) return undefined;
  if (
    err instanceof DOMException &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  ) {
    return 'timeout';
  }
  // `fetch` surfaces a network-level failure as `TypeError`, and `apiGet`
  // flattens one to `.status = 0`.
  if (err instanceof TypeError || status === 0) return 'network';
  // No status, not a network fault: a bug in our own code. Report it as
  // deterministic — hammering a programming error three times only delays the
  // report and muddies the logs.
  return 'fatal';
}

/** Injectable knobs for {@link retryTransient} (tests avoid real timers). */
export interface RetryOptions {
  /** Sleep implementation (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Uniform [0,1) source for the jitter (default: Math.random). */
  random?: () => number;
}

/**
 * Run an async operation with bounded retries on transient failures.
 *
 * The loop lives here because its subject is not a `fetch` — presign goes
 * through `apiGet` (axios), which the shared HTTP transport cannot drive. What
 * it must NOT own is a second opinion on what deserves a retry, so the verdict
 * and the backoff both come from `decideRetry`: one place decides, two
 * places execute.
 * @param fn - The operation; receives the 0-based attempt index.
 * @param opts - Injectable timer and randomness, for deterministic tests.
 * @returns The first successful result.
 * @throws {unknown} The last error once the shared budget is spent, or the
 *   first non-transient error immediately.
 */
export async function retryTransient<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let index = 0; ; index++) {
    try {
      return await fn(index);
    } catch (err: unknown) {
      const status = errorStatus(err);
      const decision = decideRetry({
        status: status === null || status === 0 ? undefined : status,
        transportError: transportKind(err, status),
        // Presign is an idempotent signature issue and a PUT overwrites the
        // same key with the same bytes — replaying either is side-effect free.
        replaySafe: true,
        attempt: index + 1,
        ...(opts.random !== undefined && { rand: opts.random }),
      });
      if (!decision.retry) throw err;
      await sleep(decision.delayMs);
    }
  }
}

/**
 * Per-attempt PUT timeout: a stall guard, not a UX deadline. Scales with
 * file size at the minimum acceptable transfer rate so a legitimately
 * slow big upload never trips it, floored at the API request timeout.
 * @param sizeBytes - The file size about to be PUT.
 * @param cfg - The upload knobs.
 * @returns The per-attempt timeout in milliseconds.
 */
export function computePutTimeoutMs(
  sizeBytes: number,
  cfg: UploadClientConfig,
): number {
  return Math.max(
    cfg.clientRequestTimeoutMs,
    Math.ceil((sizeBytes / cfg.clientPutMinBytesPerSec) * 1000),
  );
}

/** Injectable deps for {@link putFileWithRetry}. */
export interface PutFileDeps {
  /** fetch implementation (default: global fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Replacement for the transport's backoff wait (tests).
   *
   * Without it this function's tests sleep through the real jittered backoff
   * on every run — several seconds of nothing, sitting next to
   * timing-sensitive assertions. `retryTransient` above kept its own seam
   * because it still owns its loop; this one had to move down into the
   * transport, since that is where the waiting now happens.
   */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * PUT a file to its presigned URL with the full resilience treatment:
 * per-attempt stall-guard timeout, bounded retries on transient failures,
 * full-jittered backoff. Same wire shape as the legacy single-shot
 * `assetsApi.putFile` (content-type header + same-origin credentials).
 * @param uploadUrl - The presigned PUT target.
 * @param file - The file to upload.
 * @param cfg - The upload knobs from `GET /assets/upload-config`.
 * @param deps - Injectable fetch (tests).
 * @throws {UploadHttpError} On a final non-2xx response.
 * @throws {unknown} On a final network/timeout failure.
 */
export async function putFileWithRetry(
  uploadUrl: string,
  file: File,
  cfg: UploadClientConfig,
  deps: PutFileDeps = {},
): Promise<void> {
  const res = await httpRequest(
    uploadUrl,
    {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
      credentials: 'same-origin',
    },
    {
      // Same presigned key, same bytes: a replay overwrites with identical
      // content, so there is nothing to duplicate.
      replaySafe: true,
      // The stall guard scales with file size — which is exactly why the
      // timeout stays a parameter while the attempt count does not.
      timeoutMs: computePutTimeoutMs(file.size, cfg),
      ...(deps.fetchImpl !== undefined && { fetchImpl: deps.fetchImpl }),
      ...(deps.sleepImpl !== undefined && { sleepImpl: deps.sleepImpl }),
    },
  );
  if (!res.ok) throw new UploadHttpError(res.status);
}
