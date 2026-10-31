// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '@web/data/api/types';
import { retryTransient } from '@web/data/upload/upload-retry';

/**
 * Control when a retry's injected waiting period ends.
 * @returns The waiting promise and its completion function.
 * @throws {never} Never directly.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('retryTransient cancellation', () => {
  it('rejects a pre-cancelled attempt without invoking the operation', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn().mockResolvedValue('late result');

    await expect(retryTransient(operation, { attempts: 3, baseDelayMs: 100, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });

    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects cancellation instead of returning a late successful operation', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => { controller.abort(); return 'late result'; });

    await expect(retryTransient(operation, { attempts: 3, baseDelayMs: 100, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not sleep or retry after cancellation accompanies a transient failure', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort();
      throw new ApiException({ status: 503, message: 'unavailable' });
    });
    const sleep = vi.fn(async (): Promise<void> => undefined);

    await expect(retryTransient(operation, { attempts: 3, baseDelayMs: 100, signal: controller.signal, sleep }))
      .rejects.toMatchObject({ name: 'AbortError' });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('ends a cancelled backoff before the injected wait resolves', async () => {
    const controller = new AbortController();
    const entered = deferred();
    const waiting = deferred();
    const operation = vi.fn()
      .mockRejectedValueOnce(new ApiException({ status: 503, message: 'unavailable' }))
      .mockResolvedValue('retry result');
    const sleep = vi.fn(() => { entered.resolve(); return waiting.promise; });
    let ending: unknown = 'pending';
    const running = retryTransient(operation, { attempts: 3, baseDelayMs: 100, signal: controller.signal, sleep });
    const observed = running.then(() => { ending = 'resolved'; }, (error: unknown) => { ending = error; });
    await entered.promise;
    controller.abort();
    try {
      await vi.waitFor(() => expect(ending).toMatchObject({ name: 'AbortError' }), { timeout: 1000 });
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      waiting.resolve();
      await observed;
    }
  });

  it('preserves a non-transient API refusal when the signal is live', async () => {
    const refused = new ApiException({ status: 403, message: 'forbidden' });
    const operation = vi.fn().mockRejectedValue(refused);

    await expect(retryTransient(operation, { attempts: 3, baseDelayMs: 100, signal: new AbortController().signal }))
      .rejects.toBe(refused);

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
