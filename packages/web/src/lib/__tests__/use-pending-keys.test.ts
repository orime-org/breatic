// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { usePendingKeys } from '@web/lib/use-pending-keys';

/** A promise and the two levers that settle it. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * A promise settled from outside.
 * @returns The promise and its resolve / reject.
 */
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('usePendingKeys', () => {
  it('holds each key until its own work settles, whichever answers first', async () => {
    const { result } = renderHook(() => usePendingKeys());
    const a = deferred();
    const b = deferred();

    act(() => {
      result.current.track('a', a.promise);
      result.current.track('b', b.promise);
    });
    expect(result.current.isPending('a')).toBe(true);
    expect(result.current.isPending('b')).toBe(true);

    await act(async () => {
      b.resolve();
      await b.promise;
    });
    expect(result.current.isPending('a')).toBe(true);
    expect(result.current.isPending('b')).toBe(false);

    await act(async () => {
      a.reject(new Error('refused'));
      await a.promise.catch(() => undefined);
    });
    expect(result.current.isPending('a')).toBe(false);
  });

  it('keeps the key while a second press on it is still out', async () => {
    const { result } = renderHook(() => usePendingKeys());
    const first = deferred();
    const second = deferred();

    act(() => {
      result.current.track('a', first.promise);
      result.current.track('a', second.promise);
    });
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(result.current.isPending('a')).toBe(true);

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(result.current.isPending('a')).toBe(false);
  });

  it('returns the work it was handed so the caller can wait on it', async () => {
    const { result } = renderHook(() => usePendingKeys());
    const work = deferred();
    let handed: Promise<void> | undefined;
    act(() => {
      handed = result.current.track('a', work.promise);
    });
    expect(handed).toBe(work.promise);
    work.resolve();
    await act(async () => {
      await handed;
    });
  });
});
