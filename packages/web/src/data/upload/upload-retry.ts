// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Browser upload resilience (asset slice 2, #1609; closes resilience gap
 * ⑤). presign + PUT each get 3 attempts (first + 2 retries, matching the
 * backend job_attempts=3), full-jittered exponential backoff, and a
 * per-attempt timeout so a dead connection aborts + retries instead of
 * hanging forever. Only transient failures retry — a 4xx is a fact, not
 * weather. Knob values come from `GET /assets/upload-config`
 * (config/storage.yaml `upload:` section), session-cached by the caller.
 */

/** The upload knobs served by `GET /assets/upload-config` (camelCase wire). */
export interface UploadClientConfig {
  /** Hard upload cap in bytes (pre-checked on selection; server 413s). */
  maxUploadBytes: number;
  /** Attempts per operation including the first. */
  clientMaxAttempts: number;
  /** Base backoff (ms); full jitter on base * 2^attemptIndex. */
  clientRetryBaseDelayMs: number;
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
 * Extract an HTTP status from an upload/presign error, if it carries one
 * ({@link UploadHttpError} or an axios-shaped `{ response: { status } }`).
 * @param err - The thrown value.
 * @returns The status, or null when the error carries none (network-level).
 */
function errorStatus(err: unknown): number | null {
  if (err instanceof UploadHttpError) return err.status;
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const status = (err as { response?: { status?: unknown } }).response?.status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/**
 * Whether an upload/presign failure is transient (worth retrying): 5xx /
 * 429 responses, network failures (fetch `TypeError`), and per-attempt
 * aborts/timeouts. Other 4xx and unknown programming errors are final.
 * @param err - The thrown value.
 * @returns True when a retry could plausibly succeed.
 */
export function isTransientUploadError(err: unknown): boolean {
  const status = errorStatus(err);
  if (status !== null) return status >= 500 || status === 429;
  if (err instanceof TypeError) return true;
  if (
    err instanceof DOMException &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  ) {
    return true;
  }
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

/** Injectable deps for {@link putFileWithRetry} (tests inject both). */
export interface PutFileDeps {
  /** fetch implementation (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Sleep implementation forwarded to the retry loop. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * PUT a file to its presigned URL with the full resilience treatment:
 * per-attempt stall-guard timeout, bounded retries on transient failures,
 * full-jittered backoff. Same wire shape as the legacy single-shot
 * `assetsApi.putFile` (content-type header + same-origin credentials).
 * @param uploadUrl - The presigned PUT target.
 * @param file - The file to upload.
 * @param cfg - The upload knobs from `GET /assets/upload-config`.
 * @param deps - Injectable fetch/sleep (tests).
 * @throws {UploadHttpError} On a final non-2xx response.
 * @throws {unknown} On a final network/timeout failure.
 */
export async function putFileWithRetry(
  uploadUrl: string,
  file: File,
  cfg: UploadClientConfig,
  deps: PutFileDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = computePutTimeoutMs(file.size, cfg);
  await retryTransient(
    async () => {
      const res = await fetchImpl(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new UploadHttpError(res.status);
    },
    {
      attempts: cfg.clientMaxAttempts,
      baseDelayMs: cfg.clientRetryBaseDelayMs,
      ...(deps.sleep !== undefined && { sleep: deps.sleep }),
    },
  );
}
