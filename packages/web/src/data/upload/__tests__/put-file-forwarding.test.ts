// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What `putFileWithRetry` tells the shared transport.
 *
 * The PUT target is a URL the server handed us. Under s3 / aliyun_oss it is
 * the object store; under `STORAGE_PROVIDER=local` it is this very server
 * (`server/src/routes/assets.ts:214`). The browser cannot tell which, and does
 * not need to: either way it is not an API call made under our own
 * conventions, which is what separates it from presign.
 *
 * Behavioural rather than structural, because two of the things that must hold
 * cannot be read off the call site:
 *
 *   - `replaySafe: true` is what keeps the retry. A PUT of the same bytes to
 *     the same presigned key produces the same result, so a replay costs
 *     nothing; declaring `false` would silently drop the 5xx and dropped-
 *     connection retries this code has today.
 *   - The stall-guard deadline must arrive as `timeoutMs`. It used to ride in
 *     as `init.signal`, and the transport replaces the caller's signal — left
 *     there it becomes a no-op and a slow upload silently gets the transport's
 *     300s default instead of a deadline scaled to the file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpRetryError } from '@breatic/shared';
import type * as sharedModule from '@breatic/shared';

const httpRequestMock = vi.fn();

vi.mock('@breatic/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

import {
  putFileWithRetry,
  computePutTimeoutMs,
  UploadHttpError,
  type UploadClientConfig,
} from '@web/data/upload/upload-retry';

const CFG: UploadClientConfig = {
  maxUploadBytes: 2_147_483_648,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 1000,
  clientRequestTimeoutMs: 30_000,
  clientPutMinBytesPerSec: 65_536,
};

/**
 * A file big enough that the stall guard, not the floor, sets the deadline.
 * @returns A File whose size exceeds `clientRequestTimeoutMs * rate / 1000`.
 */
const bigFile = (): File =>
  new File([new Uint8Array(4 * 1024 * 1024)], 'clip.mp4', { type: 'video/mp4' });

describe('putFileWithRetry hands the PUT to the shared transport', () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 200 }));
  });

  it('declares the PUT replay-safe and passes the stall guard as a deadline', async () => {
    const file = bigFile();
    await putFileWithRetry('https://store.test/key?sig=abc', file, CFG);

    // Strict equality on the whole options object: replaySafe flipping to
    // false would silently take the 5xx and dropped-connection retries away,
    // and a missing timeoutMs would swap the size-scaled guard for 300s.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({
      replaySafe: true,
      timeoutMs: computePutTimeoutMs(file.size, CFG),
    });
  });

  it('sends the same wire shape, with no signal left in the init', async () => {
    const file = bigFile();
    await putFileWithRetry('https://store.test/key?sig=abc', file, CFG);

    const init = httpRequestMock.mock.calls[0]![1] as RequestInit;
    expect(httpRequestMock.mock.calls[0]![0]).toBe('https://store.test/key?sig=abc');

    // The body is asserted by IDENTITY, not by structure. `toStrictEqual`
    // cannot tell two Files apart under jsdom — the wrapper carries no
    // enumerable own properties, so bytes, name and type are all invisible to
    // it, and a structural assertion here passes while the wrong file goes on
    // the wire. Measured: replacing `body: file` with a one-byte File left all
    // 23 tests green.
    expect(init.body).toBe(file);

    // The rest are literals, where structure is what there is to check. Strict
    // equality also catches a leftover `signal`: the transport replaces it, so
    // one left here is a deadline that silently does nothing.
    expect({ ...init, body: undefined }).toStrictEqual({
      method: 'PUT',
      body: undefined,
      headers: { 'Content-Type': 'video/mp4' },
      credentials: 'same-origin',
    });
  });

  it('still reports a non-2xx as an UploadHttpError carrying the status', async () => {
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 403 }));

    await expect(
      putFileWithRetry('https://store.test/key?sig=abc', bigFile(), CFG),
    ).rejects.toThrow(UploadHttpError);
    await expect(
      putFileWithRetry('https://store.test/key?sig=abc', bigFile(), CFG),
    ).rejects.toMatchObject({ status: 403 });
  });

  // The third exit, and the one with nothing else guarding it: when no
  // delivery produced a response the transport throws, and this function must
  // not catch it. Swallowing it, or rewriting it as an UploadHttpError, turns
  // "the network never answered" into something the caller reads as an HTTP
  // outcome.
  //
  // Both shapes are pinned because the transport throws two, and a catch that
  // narrows on one of them would slip past a test that only knows the other.
  // HttpRetryError is the shape that matters most here — request.ts rethrows
  // the original only when the first delivery failed, and a File body is
  // replayable, so a replay-safe PUT reaching this exit has usually replayed.
  it('lets a replayed transport failure through untouched', async () => {
    const failure = new HttpRetryError('http request to https://store.test failed after 3 attempts', 3, new TypeError('fetch failed'));
    httpRequestMock.mockImplementation(async () => {
      throw failure;
    });

    await expect(
      putFileWithRetry('https://store.test/key?sig=abc', bigFile(), CFG),
    ).rejects.toBe(failure);
  });

  it('lets a first-delivery failure through untouched', async () => {
    const failure = new TypeError('fetch failed');
    httpRequestMock.mockImplementation(async () => {
      throw failure;
    });

    await expect(
      putFileWithRetry('https://store.test/key?sig=abc', bigFile(), CFG),
    ).rejects.toBe(failure);
  });

  it('makes exactly one call — retrying is the transport’s job now', async () => {
    // The old loop retried 5xx itself. If that machinery is still in place a
    // transport-level failure would produce more than one call here.
    httpRequestMock.mockImplementation(async () => new Response(null, { status: 503 }));

    await expect(
      putFileWithRetry('https://store.test/key?sig=abc', bigFile(), CFG),
    ).rejects.toThrow(UploadHttpError);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });
});
