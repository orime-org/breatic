// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';

import {
  retryTransient,
  isTransientUploadError,
  computePutTimeoutMs,
  putFileWithRetry,
  UploadHttpError,
  type UploadClientConfig,
} from '@web/data/upload/upload-retry';

const CFG: UploadClientConfig = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 1000,
  clientRequestTimeoutMs: 30000,
  clientPutMinBytesPerSec: 65536,
};

/** A no-wait sleep spy so tests never touch real timers. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe('isTransientUploadError — retry only what can heal', () => {
  it('retries 5xx and 429, never other 4xx', () => {
    expect(isTransientUploadError(new UploadHttpError(500))).toBe(true);
    expect(isTransientUploadError(new UploadHttpError(503))).toBe(true);
    expect(isTransientUploadError(new UploadHttpError(429))).toBe(true);
    expect(isTransientUploadError(new UploadHttpError(403))).toBe(false);
    expect(isTransientUploadError(new UploadHttpError(413))).toBe(false);
    expect(isTransientUploadError(new UploadHttpError(422))).toBe(false);
  });

  it('retries network failures and per-attempt timeouts', () => {
    expect(isTransientUploadError(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      isTransientUploadError(new DOMException('aborted', 'AbortError')),
    ).toBe(true);
    expect(
      isTransientUploadError(new DOMException('timed out', 'TimeoutError')),
    ).toBe(true);
  });

  it('reads status off axios-shaped errors (presign path)', () => {
    expect(isTransientUploadError({ response: { status: 502 } })).toBe(true);
    expect(isTransientUploadError({ response: { status: 404 } })).toBe(false);
  });

  it('reads status off the project ApiException flat .status (real presign error shape)', () => {
    // apiGet rejects with ApiException { status, name: 'ApiException' } —
    // a FLAT status, not { response: { status } }. Adversarial #2: without
    // this, every transient presign failure (503/429/network-0) is judged
    // non-transient and the presign retry is dead.
    const apiErr = (status: number): unknown => {
      const e = new Error('api') as Error & { status: number; name: string };
      e.name = 'ApiException';
      e.status = status;
      return e;
    };
    expect(isTransientUploadError(apiErr(503))).toBe(true);
    expect(isTransientUploadError(apiErr(429))).toBe(true);
    expect(isTransientUploadError(apiErr(0))).toBe(true); // network drop
    expect(isTransientUploadError(apiErr(403))).toBe(false);
    expect(isTransientUploadError(apiErr(413))).toBe(false);
  });

  it('does not retry unknown programming errors', () => {
    expect(isTransientUploadError(new Error('undefined is not a function'))).toBe(
      false,
    );
  });
});

describe('retryTransient — 3 attempts, full-jitter backoff', () => {
  it('retries transient failures up to the attempt budget then throws', async () => {
    const fn = vi.fn().mockRejectedValue(new UploadHttpError(500));
    const { sleep, delays } = fakeSleep();

    await expect(
      retryTransient(fn, {
        attempts: 3,
        baseDelayMs: 1000,
        sleep,
        random: () => 1,
      }),
    ).rejects.toBeInstanceOf(UploadHttpError);
    expect(fn).toHaveBeenCalledTimes(3);
    // full jitter with random()=1 → base * 2^attemptIndex
    expect(delays).toEqual([1000, 2000]);
  });

  it('stops immediately on a non-transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new UploadHttpError(403));
    const { sleep } = fakeSleep();

    await expect(
      retryTransient(fn, { attempts: 3, baseDelayMs: 1000, sleep }),
    ).rejects.toBeInstanceOf(UploadHttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops on first success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce('ok');
    const { sleep } = fakeSleep();

    await expect(
      retryTransient(fn, { attempts: 3, baseDelayMs: 1000, sleep }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('computePutTimeoutMs — stall guard scales with size', () => {
  it('uses the request-timeout floor for small files', () => {
    expect(computePutTimeoutMs(1024, CFG)).toBe(30000);
  });

  it('scales by the minimum acceptable rate for large files', () => {
    // 6553600 bytes at 65536 B/s = 100s > 30s floor
    expect(computePutTimeoutMs(6553600, CFG)).toBe(100000);
  });

  it('keeps a 2 GiB file (the upload cap) below the 32-bit setTimeout ceiling', () => {
    // Guard invariant: a timeout past 2,147,483,647 ms (the int32
    // setTimeout / AbortSignal.timeout limit) overflows to ~0 and aborts
    // the PUT instantly. At the 2 GiB cap and 65536 B/s floor the timeout
    // is ~32.8M ms (~9h) — comfortably under the ceiling — so no clamp is
    // needed today. This test fails the day someone shrinks the rate floor
    // or raises the cap enough to approach the limit, forcing a clamp then.
    const t = computePutTimeoutMs(2147483648, CFG);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(2147483647);
  });
});

describe('putFileWithRetry — PUT with attempts + timeout signal', () => {
  const file = new File(['x'.repeat(16)], 'a.png', { type: 'image/png' });

  it('resolves on success and sends content-type + same-origin credentials + a signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await putFileWithRetry('https://put', file, CFG, {
      fetchImpl,
      sleep: fakeSleep().sleep,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://put');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(init.credentials).toBe('same-origin');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries 5xx to the attempt budget then throws the HTTP error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { sleep } = fakeSleep();

    await expect(
      putFileWithRetry('https://put', file, CFG, { fetchImpl, sleep }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const { sleep } = fakeSleep();

    await expect(
      putFileWithRetry('https://put', file, CFG, { fetchImpl, sleep }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const { sleep } = fakeSleep();

    await expect(
      putFileWithRetry('https://put', file, CFG, { fetchImpl, sleep }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
