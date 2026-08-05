// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import {
  retryTransient,
  isTransientUploadError,
  computePutTimeoutMs,
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
  // Carried on a flat `.status`, which is the only shape that reaches this
  // function now: presign is its one caller, and axios normalises every
  // failure into an ApiException before it arrives.
  it('retries 5xx and 429, never other 4xx', () => {
    expect(isTransientUploadError({ status: 500 })).toBe(true);
    expect(isTransientUploadError({ status: 503 })).toBe(true);
    expect(isTransientUploadError({ status: 429 })).toBe(true);
    expect(isTransientUploadError({ status: 403 })).toBe(false);
    expect(isTransientUploadError({ status: 413 })).toBe(false);
    expect(isTransientUploadError({ status: 422 })).toBe(false);
  });

  it('reads status off the project ApiException flat .status (real presign error shape)', () => {
    // apiGet rejects with ApiException, whose status is FLAT on `.status` and
    // not at `{ response: { status } }`. Adversarial #2: without this, every
    // transient presign failure (503/429/network-0) is judged non-transient
    // and the presign retry is dead. The real class is constructed here rather
    // than a stand-in shaped like it, so that a change to the class is a
    // change to this fixture.
    const apiErr = (status: number): unknown =>
      new ApiException({ status, message: 'api' });
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

// Every fixture below is an ApiException, because presign is the only caller
// this loop has left. It used to be driven with `UploadHttpError`, which reads
// naturally but is a pairing production can no longer produce: that class is
// thrown by `putFileWithRetry` alone, and that function no longer goes through
// this loop. Same judgment that deleted two unreachable branches from the
// predicate — a test of a pairing nobody can reach protects nothing.
describe('retryTransient — 3 attempts, full-jitter backoff', () => {
  it('retries transient failures up to the attempt budget then throws', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new ApiException({ status: 500, message: 'boom' }));
    const { sleep, delays } = fakeSleep();

    await expect(
      retryTransient(fn, {
        attempts: 3,
        baseDelayMs: 1000,
        sleep,
        random: () => 1,
      }),
    ).rejects.toBeInstanceOf(ApiException);
    expect(fn).toHaveBeenCalledTimes(3);
    // full jitter with random()=1 → base * 2^attemptIndex
    expect(delays).toEqual([1000, 2000]);
  });

  it('stops immediately on a non-transient error', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new ApiException({ status: 403, message: 'nope' }));
    const { sleep } = fakeSleep();

    await expect(
      retryTransient(fn, { attempts: 3, baseDelayMs: 1000, sleep }),
    ).rejects.toBeInstanceOf(ApiException);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops on first success', async () => {
    // A network-level presign failure, which apiGet reports as status 0 —
    // this used to be a bare `TypeError`, the shape raw `fetch` throws, back
    // when this loop still wrapped the PUT.
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 0, message: 'network' })
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
    // This value is now handed to the shared HTTP transport as its
    // per-delivery deadline, and the transport REFUSES an out-of-range one at
    // the boundary — `usableDeadline` throws before the loop, so not a single
    // byte is sent. That is a deliberate choice on its side over clamping.
    //
    // The old path did NOT behave that way, and an earlier version of this
    // comment said it did. `AbortSignal.timeout` takes an [EnforceRange]
    // unsigned long long, deliberately unlike setTimeout's 32-bit argument, so
    // a browser accepts 2147483648 as a 24.8-day deadline. Measured in Chrome
    // 150: that signal had not aborted 400ms later, while a 50ms control had.
    // Overflowing to ~1ms is Node's timers — another runtime, and this file
    // only ever runs in a browser.
    //
    // Pinned here: at the shipped pair of values the deadline stays in range,
    // with ~65x of headroom. Be exact about what this does NOT do — CFG is a
    // literal in this file, so it cannot notice a change to storage.yaml, and
    // a config able to cross the ceiling would leave it green. That is not the
    // hole it used to be: `storageConfigSchema` now refuses such a pair at
    // load, so no reachable config can hand this function an unusable figure.
    // The invariant lives there, in core; this stays a check on the shipped
    // numbers.
    const t = computePutTimeoutMs(2147483648, CFG);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(2147483647);
  });
});
