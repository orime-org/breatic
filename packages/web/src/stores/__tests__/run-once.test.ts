// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press, one execution (inner#1490): the registry keeps a press waiting
 * outside the panel that started it, re-sends an unanswered press with the
 * same key and body until the server says it finished, and lets go of it on
 * the events that end it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import {
  IDEMPOTENCY_CLIENT_MARGIN_SECONDS,
  IDEMPOTENCY_RETENTION_SECONDS,
  t,
} from '@breatic/shared';
import { toast } from '@web/lib/toast';
import { ApiException, type ApiError } from '@web/data/api/types';
import { useCurrentUserStore, type CurrentUser } from '@web/stores/current-user';
import {
  getRunning,
  resetRunOnceForTests,
  runOnce,
} from '@web/stores/task-actions-in-flight';

/**
 * A failed answer as the API helpers reject with it.
 * @param error - The normalized error.
 * @returns The exception.
 */
function failed(error: ApiError): ApiException {
  return new ApiException(error);
}

/** A promise the case settles by hand. */
interface Pending<R> {
  promise: Promise<R>;
  resolve: (value: R) => void;
  reject: (err: unknown) => void;
}

/**
 * A promise the case settles by hand.
 * @returns The promise and its two settlers.
 */
function pending<R>(): Pending<R> {
  let resolve: (value: R) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<R>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const USER: CurrentUser = {
  id: 'user-a',
  name: 'A',
  email: 'a@example.test',
  personalStudio: null,
  membershipTier: 'base',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useCurrentUserStore.getState().setUser(USER);
});

afterEach(() => {
  resetRunOnceForTests();
  vi.useRealTimers();
});

describe('runOnce', () => {
  it('holds the press as waiting until the answer arrives, then lets go', async () => {
    const answer = pending<{ id: string }>();
    const onDone = vi.fn();
    void runOnce('project:create', {
      scope: 'project',
      meta: 'studio-1',
      prepare: () => ({ name: 'x' }),
      send: () => answer.promise,
      onDone,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(getRunning('project:create')).toBe('studio-1');

    answer.resolve({ id: 'p1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onDone).toHaveBeenCalledWith({ id: 'p1' });
    expect(getRunning('project:create')).toBeUndefined();
  });

  it('does not prepare or send a second time while the first press waits', async () => {
    const answer = pending<null>();
    const prepare = vi.fn(() => ({}));
    const send = vi.fn(() => answer.promise);
    void runOnce('generate:s:n', { scope: 'generate', prepare, send });
    void runOnce('generate:s:n', { scope: 'generate', prepare, send });
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    answer.resolve(null);
  });

  it('runs a new press once the first has its answer', async () => {
    const send = vi.fn((_key: string, _body: unknown) => Promise.resolve(null));
    await runOnce('generate:s:n', { scope: 'generate', prepare: () => ({}), send });
    await runOnce('generate:s:n', { scope: 'generate', prepare: () => ({}), send });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).not.toBe(send.mock.calls[1]?.[0]);
  });

  // A self-hosted deployment opened over plain http on a LAN address is not a
  // secure context, and browsers leave `crypto.randomUUID` out there.
  it('sends from a page that is not a secure context', async () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    try {
      const send = vi.fn((_key: string, _body: unknown) => Promise.resolve(null));
      await runOnce('generate:s:n', { scope: 'generate', prepare: () => ({}), send });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(getRunning('generate:s:n')).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ends without sending when prepare decides there is nothing to send', async () => {
    const send = vi.fn();
    await runOnce('mini-tool:s:n:x', { scope: 'mini-tool', prepare: () => null, send });
    expect(send).not.toHaveBeenCalled();
    expect(getRunning('mini-tool:s:n:x')).toBeUndefined();
  });

  it('lets go and reports when prepare throws', async () => {
    const onFailure = vi.fn();
    const boom = new Error('payload');
    await runOnce('generate:s:n', {
      scope: 'generate',
      prepare: () => {
        throw boom;
      },
      send: vi.fn(),
      onFailure,
    });
    expect(onFailure).toHaveBeenCalledWith(boom);
    expect(getRunning('generate:s:n')).toBeUndefined();
  });

  it.each([
    ['no answer at all', { status: 0, message: 'net', network: true }],
    ['still running', { status: 409, message: 'busy', idempotencyStatus: 'in_progress' as const }],
    ['a proxy timing out', { status: 524, message: 'cf' }],
    ['a gateway error', { status: 502, message: 'bad gateway' }],
    ['a throttle', { status: 429, message: 'slow', retryAfterSeconds: 3 }],
  ])('re-sends the same key and body after %s, until the server finishes', async (_case, error) => {
    const body = { prompt: 'cat' };
    const send = vi
      .fn<(key: string, sent: unknown) => Promise<string>>()
      .mockRejectedValueOnce(failed(error))
      .mockResolvedValueOnce('done');
    const onDone = vi.fn();
    void runOnce('generate:s:n', { scope: 'generate', prepare: () => body, send, onDone });
    await vi.advanceTimersByTimeAsync(0);
    expect(getRunning('generate:s:n')).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe(send.mock.calls[0]?.[0]);
    expect(send.mock.calls[1]?.[1]).toBe(body);
    expect(onDone).toHaveBeenCalledWith('done');
    expect(getRunning('generate:s:n')).toBeUndefined();
  });

  it('waits as long as a throttle names before asking again', async () => {
    const send = vi
      .fn<() => Promise<null>>()
      .mockRejectedValueOnce(failed({ status: 429, message: 'slow', retryAfterSeconds: 20 }))
      .mockResolvedValueOnce(null);
    void runOnce('credits:checkout', { scope: 'credits-checkout', prepare: () => ({}), send });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('treats an error the server finished with as the answer', async () => {
    const onFailure = vi.fn();
    const err = failed({ status: 403, message: 'no', idempotencyStatus: 'done', fromServer: true });
    const send = vi.fn().mockRejectedValueOnce(err);
    await runOnce('understand:s:n', { scope: 'understand', prepare: () => ({}), send, onFailure });
    expect(onFailure).toHaveBeenCalledWith(err);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getRunning('understand:s:n')).toBeUndefined();
  });

  // The handler itself failed with a 500 and the server stored that: asking
  // again only replays the same 500.
  it('treats a server error the server finished with as the answer', async () => {
    const onFailure = vi.fn();
    const err = failed({ status: 500, message: 'oops', idempotencyStatus: 'done', fromServer: true });
    const send = vi.fn().mockRejectedValue(err);
    await runOnce('generate:s:n', { scope: 'generate', prepare: () => ({}), send, onFailure });
    expect(onFailure).toHaveBeenCalledWith(err);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats a refusal before the press ran as the answer', async () => {
    const onFailure = vi.fn();
    const err = failed({ status: 422, message: 'bad', fromServer: true });
    const send = vi.fn().mockRejectedValueOnce(err);
    await runOnce('generate:s:n', { scope: 'generate', prepare: () => ({}), send, onFailure });
    expect(onFailure).toHaveBeenCalledWith(err);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats a local throw in send as the answer', async () => {
    const onFailure = vi.fn();
    const send = vi.fn().mockRejectedValueOnce(new TypeError('x is undefined'));
    await runOnce('generate:s:n', { scope: 'generate', prepare: () => ({}), send, onFailure });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('hands a 400 the server words itself to the press, like any refusal', async () => {
    const onFailure = vi.fn();
    const err = failed({ status: 400, message: 'Refresh it', fromServer: true });
    await runOnce('generate:s:n', {
      scope: 'generate',
      prepare: () => ({}),
      send: vi.fn().mockRejectedValueOnce(err),
      onFailure,
    });
    expect(onFailure).toHaveBeenCalledWith(err);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('resolves with how the press ended', async () => {
    const err = failed({ status: 422, message: 'bad', fromServer: true });
    await expect(
      runOnce('a', { scope: 'project', prepare: () => ({}), send: () => Promise.resolve('p1') }),
    ).resolves.toEqual({ kind: 'done', result: 'p1' });
    await expect(
      runOnce('b', { scope: 'project', prepare: () => ({}), send: () => Promise.reject(err) }),
    ).resolves.toEqual({ kind: 'failed', error: err });
    await expect(
      runOnce('c', { scope: 'project', prepare: () => null, send: vi.fn() }),
    ).resolves.toEqual({ kind: 'released' });

    const answer = pending<string>();
    const outcome = runOnce('d', { scope: 'project', prepare: () => ({}), send: () => answer.promise });
    await vi.advanceTimersByTimeAsync(0);
    useCurrentUserStore.getState().setUser(null);
    answer.resolve('late');
    await expect(outcome).resolves.toEqual({ kind: 'released' });
  });

  it('gives a second press of the same intent the first press\'s outcome', async () => {
    const answer = pending<string>();
    const spec = { scope: 'project' as const, prepare: () => ({}), send: () => answer.promise };
    const first = runOnce('project:create', spec);
    const second = runOnce('project:create', spec);
    answer.resolve('p1');
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ kind: 'done', result: 'p1' });
  });

  it('stops asking before the server forgets the press, and says so', async () => {
    const send = vi.fn().mockRejectedValue(failed({ status: 0, message: 'net', network: true }));
    void runOnce('credits:checkout', { scope: 'credits-checkout', prepare: () => ({}), send });
    await vi.advanceTimersByTimeAsync(0);
    const stopAfterMs =
      (IDEMPOTENCY_RETENTION_SECONDS['credits-checkout'] - IDEMPOTENCY_CLIENT_MARGIN_SECONDS) *
      1000;
    // A laptop asleep: the wall clock jumps while no timer fires.
    vi.setSystemTime(Date.now() + stopAfterMs);
    const sentBefore = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send.mock.calls.length).toBe(sentBefore);
    expect(getRunning('credits:checkout')).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(t('common.runOnce.unknownResult'));
  });

  it('keeps a press that left for another page waiting, until the page comes back', async () => {
    await runOnce('membership', {
      scope: 'membership',
      meta: 'pro',
      prepare: () => ({}),
      send: () => Promise.resolve({ url: 'https://checkout.example' }),
      onDone: () => 'leaving',
    });
    expect(getRunning('membership')).toBe('pro');

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(getRunning('membership')).toBeUndefined();
  });

  // Only a press leaving the page needs to hear about a restore; a listener
  // left on the window otherwise holds this module for the page's life.
  it('listens for a page restore only while a press is leaving', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await runOnce('generate:s:n', { scope: 'generate', prepare: () => ({}), send: () => Promise.resolve(null) });
    expect(add.mock.calls.filter(([type]) => type === 'pageshow')).toHaveLength(0);

    await runOnce('credits:checkout', {
      scope: 'credits-checkout',
      prepare: () => ({}),
      send: () => Promise.resolve({ url: 'x' }),
      onDone: () => 'leaving',
    });
    expect(add.mock.calls.filter(([type]) => type === 'pageshow')).toHaveLength(1);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(remove.mock.calls.filter(([type]) => type === 'pageshow')).toHaveLength(1);
  });

  it('lets every press go when the signed-in account changes', async () => {
    const send = vi.fn().mockRejectedValue(failed({ status: 0, message: 'net', network: true }));
    void runOnce('generate:s:n', { scope: 'generate', prepare: () => ({}), send });
    await vi.advanceTimersByTimeAsync(0);
    expect(getRunning('generate:s:n')).toBe(true);

    useCurrentUserStore.getState().setUser({ ...USER, id: 'user-b' });
    expect(getRunning('generate:s:n')).toBeUndefined();
    const sentBefore = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send.mock.calls.length).toBe(sentBefore);
  });

  it('ignores an answer that arrives after the press was let go', async () => {
    const answer = pending<string>();
    const onDone = vi.fn();
    void runOnce('generate:s:n', {
      scope: 'generate',
      prepare: () => ({}),
      send: () => answer.promise,
      onDone,
    });
    await vi.advanceTimersByTimeAsync(0);
    useCurrentUserStore.getState().setUser(null);
    answer.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onDone).not.toHaveBeenCalled();
  });
});
