// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Browser upload resilience (asset slice 2, #1609; closes resilience gap ⑤).
 *
 * The two halves are no longer resilient in the same way. **Presign** talks to
 * our own backend through the axios client, and {@link retryTransient} is what
 * gives it its 3 attempts and full-jittered backoff; its knobs come from
 * `GET /assets/upload-config` (config/storage.yaml `upload:` section),
 * session-cached by the caller. **The PUT** goes to whatever URL presign
 * returned, so it goes through the shared HTTP transport, which owns its
 * retries — see {@link putFileWithRetry}.
 *
 * The two halves do not even judge "transient" the same way. Presign keeps
 * the reading below: 5xx, 429, and a network-level failure, with a 4xx taken
 * as a fact rather than weather. The transport reads the protocol instead,
 * retrying 408 and 429 despite both being 4xx.
 *
 * It would also honour `Retry-After`, but nothing on this path ever produces
 * one to read — for a different reason in each of the two storage modes, so
 * both are worth naming rather than generalising over.
 *
 * Under s3 / aliyun_oss the PUT is cross-origin, and a header has to be named
 * in `Access-Control-Expose-Headers` before the browser hands it to JS.
 * Measured against our own bucket, the PUT response exposes ETag,
 * x-oss-request-id and x-oss-version-id, and nothing else. Under
 * `STORAGE_PROVIDER=local` the target is this app's own origin, so no such
 * filter applies — but that endpoint carries only `requireAuth` and no rate
 * limiter, and the rate limiter is the one thing in the server that emits
 * `Retry-After`. Either way the transport reads null and falls back to its own
 * backoff — same three deliveries as before.
 */

import { httpRequest } from '@breatic/shared';

/** The upload knobs served by `GET /assets/upload-config` (camelCase wire). */
export interface UploadClientConfig {
  /** Hard upload cap in bytes (pre-checked on selection; server 413s). */
  maxUploadBytes: number;
  /** Presign attempts including the first; the PUT's count lives in the transport. */
  clientMaxAttempts: number;
  /** Base backoff (ms) between presign attempts; full jitter on base * 2^attemptIndex. */
  clientRetryBaseDelayMs: number;
  /** Floor for the PUT stall guard. It times no API request — presign is timed by the axios client. */
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
 * Extract an HTTP status from a presign failure, if it carries one.
 *
 * One shape reaches this now: the project's `ApiException`, whose status is
 * FLAT on `.status` and NOT at `{response:{status}}`. Reading only the axios
 * shape once left presign retries dead, which is why the flat read exists.
 *
 * The raw axios shape used to be read here as a fallback and no longer is, on
 * the same ground that removed two branches from the predicate below: apiGet's
 * interceptor turns every failure into an ApiException before anything here
 * sees it, so a raw axios error cannot arrive. Keeping one unreachable branch
 * while deleting two others would have been half a judgment.
 * @param err - The thrown value.
 * @returns The status, or null when the error carries none (network-level).
 */
function errorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const flat = (err as { status?: unknown }).status;
  if (typeof flat === 'number') return flat;
  return null;
}

/**
 * Whether a presign failure is transient (worth retrying): 5xx / 429
 * responses, and network-level failures, which apiGet reports as status 0.
 * Other 4xx and unknown programming errors are final.
 *
 * It once also recognised a bare `TypeError` and an `AbortError` /
 * `TimeoutError` — the shapes raw `fetch` throws. Those were for the PUT,
 * which now retries inside the shared transport, and the only caller left is
 * presign: it goes through axios, whose interceptor turns every failure into
 * an `ApiException` before this ever sees it. So neither shape can arrive
 * here, and a judgment nobody can reach is worse than no judgment.
 * @param err - The thrown value.
 * @returns True when a retry could plausibly succeed.
 */
export function isTransientUploadError(err: unknown): boolean {
  const status = errorStatus(err);
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
  return Math.max(
    cfg.clientRequestTimeoutMs,
    Math.ceil((sizeBytes / cfg.clientPutMinBytesPerSec) * 1000),
  );
}

/**
 * PUT a file to the URL presign handed back, through the shared transport.
 *
 * That URL is not ours to reason about. Under s3 / aliyun_oss it addresses the
 * object store; under `STORAGE_PROVIDER=local` it addresses this very server
 * (`server/src/routes/assets.ts`). The browser is given a string and cannot
 * tell which — and does not need to, because either way this is not an API
 * call made under our own conventions. That is what separates it from
 * presign, which keeps the axios client and its baseURL, credentials and
 * error envelope.
 *
 * `replaySafe`, because the same bytes to the same presigned key produce the
 * same object: a replay costs nothing and changes nothing. Declaring
 * otherwise would drop the 5xx and dropped-connection retries this path has
 * always had.
 *
 * The deadline goes in as `timeoutMs` rather than a signal on the init. It is
 * a stall guard, not a UX deadline — it scales with the file so a legitimately
 * slow big upload never trips it — and the transport replaces whatever signal
 * the caller left behind, so one passed there would silently do nothing.
 *
 * `credentials: 'same-origin'` is the one setting that has to be right in both
 * modes at once, which is why it is neither `include` nor `omit`. The cloud
 * PUT carries its signature in the URL and wants no cookie; sending one would
 * hand our session to a storage vendor. The local endpoint is our own origin
 * and authenticates by cookie, so it needs one. `same-origin` attaches it to
 * ours and never to theirs. (This reasoning used to live on `assetsApi.putFile`,
 * deleted with that function; it is written down here so it does not go with
 * the next thing that gets removed.)
 * @param uploadUrl - The PUT target presign returned.
 * @param file - The file to upload.
 * @param cfg - The upload knobs from `GET /assets/upload-config`.
 * @throws {UploadHttpError} On a non-2xx response.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function putFileWithRetry(
  uploadUrl: string,
  file: File,
  cfg: UploadClientConfig,
): Promise<void> {
  const res = await httpRequest(
    uploadUrl,
    {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
      credentials: 'same-origin',
    },
    { replaySafe: true, timeoutMs: computePutTimeoutMs(file.size, cfg) },
  );
  if (!res.ok) throw new UploadHttpError(res.status);
}
