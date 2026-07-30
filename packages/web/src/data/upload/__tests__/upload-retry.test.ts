// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Browser upload resilience.
 *
 * The verdict on what counts as transient now lives in `@breatic/shared` and is
 * exercised there (`src/http/__tests__/decide-retry.test.ts`, 42 cases) — it
 * used to be a second opinion here that had already drifted from the backend's.
 * What still belongs to this file is the browser-specific wiring:
 *
 *   - translating the three error shapes the browser produces (a PUT's
 *     `UploadHttpError`, the project's `ApiException` with a FLAT `.status`, and
 *     a raw axios error) into that shared verdict,
 *   - the stall guard that scales the PUT timeout with file size.
 *
 * The flat-status path has its own regression here because getting it wrong once
 * already made presign retries silently dead: `apiGet` normalizes every failure
 * into an `ApiException` whose status sits on `.status`, so reading only the
 * axios `{ response: { status } }` shape judged every transient presign failure
 * as final.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  retryTransient,
  computePutTimeoutMs,
  putFileWithRetry,
  UploadHttpError,
  type UploadClientConfig,
} from '@web/data/upload/upload-retry';

const CFG: UploadClientConfig = {
  maxUploadBytes: 2147483648,
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

/** An `ApiException` as `apiGet` rejects with: a FLAT `.status`. */
function apiError(status: number): unknown {
  const e = new Error('api') as Error & { status: number; name: string };
  e.name = 'ApiException';
  e.status = status;
  return e;
}

describe('retryTransient — shared budget, browser error shapes', () => {
  it('retries a transient failure to the shared budget then throws', async () => {
    const fn = vi.fn().mockRejectedValue(new UploadHttpError(500));
    const { sleep, delays } = fakeSleep();

    await expect(
      retryTransient(fn, { sleep, random: () => 1 }),
    ).rejects.toBeInstanceOf(UploadHttpError);
    // First attempt plus two retries — the count is fixed in the shared
    // transport, so the browser cannot drift from the backend.
    expect(fn).toHaveBeenCalledTimes(3);
    // random()=1 pins full jitter to its ceiling: base * 2^attemptIndex.
    expect(delays).toEqual([1000, 2000]);
  });

  it('stops immediately on a non-transient status', async () => {
    const fn = vi.fn().mockRejectedValue(new UploadHttpError(403));
    const { sleep } = fakeSleep();

    await expect(retryTransient(fn, { sleep })).rejects.toBeInstanceOf(
      UploadHttpError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops on the first success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce('ok');
    const { sleep } = fakeSleep();

    await expect(retryTransient(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reads the flat .status off an ApiException (presign retry regression)', async () => {
    // Without this translation every transient presign failure reads as final
    // and the presign retry is dead — which is exactly what shipped once.
    const { sleep } = fakeSleep();
    for (const status of [503, 429]) {
      const fn = vi.fn().mockRejectedValue(apiError(status));
      await expect(retryTransient(fn, { sleep })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(3);
    }
  });

  it('treats an ApiException status of 0 as a dropped connection, not a status code', async () => {
    // `apiGet` reports "no response reached us" as `.status = 0`. Passed to the
    // shared predicate as a status it would be a nonsensical code and refused;
    // it has to arrive as a transport failure instead.
    const { sleep } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(apiError(0));
    await expect(retryTransient(fn, { sleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a client-error ApiException', async () => {
    const { sleep } = fakeSleep();
    for (const status of [403, 413]) {
      const fn = vi.fn().mockRejectedValue(apiError(status));
      await expect(retryTransient(fn, { sleep })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('reads the nested axios shape as a defensive fallback', async () => {
    const { sleep } = fakeSleep();
    const transient = vi.fn().mockRejectedValue({ response: { status: 502 } });
    await expect(retryTransient(transient, { sleep })).rejects.toBeTruthy();
    expect(transient).toHaveBeenCalledTimes(3);

    const final = vi.fn().mockRejectedValue({ response: { status: 404 } });
    await expect(retryTransient(final, { sleep })).rejects.toBeTruthy();
    expect(final).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unknown programming error', async () => {
    const { sleep } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error('undefined is not a function'));
    await expect(retryTransient(fn, { sleep })).rejects.toThrow();
    // A bug in our own code carries no status and is not a network fault; the
    // shared predicate refuses it rather than hammering it three times.
    expect(fn).toHaveBeenCalledTimes(1);
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

describe('putFileWithRetry — PUT through the shared transport', () => {
  const file = new File(['x'.repeat(16)], 'a.png', { type: 'image/png' });

  it('sends content-type, same-origin credentials and a per-attempt signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await putFileWithRetry('https://put', file, CFG, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://put');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(init.credentials).toBe('same-origin');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a 5xx to the shared budget then throws the HTTP error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(
      putFileWithRetry('https://put', file, CFG, { fetchImpl }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });

    await expect(
      putFileWithRetry('https://put', file, CFG, { fetchImpl }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a dropped connection and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await expect(
      putFileWithRetry('https://put', file, CFG, { fetchImpl }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
