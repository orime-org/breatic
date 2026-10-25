// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  sendCorrelatedRpc,
  SpaceRpcUnanswered,
} from '@web/data/yjs/stateless-rpc-client';
import type { RpcCapableProvider } from '@web/data/yjs/space-rpc-client';

type StatelessListener = (data: { payload: string }) => void;

interface ProviderProbe extends RpcCapableProvider {
  sent: string[];
  listeners: Set<StatelessListener>;
  emit: (payload: string) => void;
  whenSending: ((payload: string) => void) | undefined;
}

const responseSchema = z.object({
  id: z.string(),
  type: z.literal('test:result'),
  ok: z.boolean(),
  value: z.number(),
}).strict();

/**
 * Build a real listener registry around the provider's minimal public contract.
 * @returns A synchronous transport probe, without a WebSocket or handshake.
 * @throws {never} Never.
 */
function makeProvider(): ProviderProbe {
  const listeners = new Set<StatelessListener>();
  const probe: ProviderProbe = {
    sent: [],
    listeners,
    whenSending: undefined,
    sendStateless(payload: string): void {
      probe.sent.push(payload);
      probe.whenSending?.(payload);
    },
    on(_event: 'stateless', callback: StatelessListener): void {
      listeners.add(callback);
    },
    off(_event: 'stateless', callback: StatelessListener): void {
      listeners.delete(callback);
    },
    emit(payload: string): void {
      for (const callback of [...listeners]) callback({ payload });
    },
  };
  return probe;
}

/**
 * Encode a valid reply whose complete payload can be asserted by the caller.
 * @param id - Correlation identity.
 * @param value - Test-specific response data.
 * @returns A JSON stateless response envelope.
 * @throws {never} Never.
 */
function reply(id: string, value = 42): string {
  return JSON.stringify({ id, type: 'test:result', ok: true, value });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('correlated stateless RPC transport', () => {
  it('sends the supplied envelope unchanged and resolves only its schema-checked reply', async () => {
    const provider = makeProvider();
    const envelope = { id: 'rpc-1', type: 'test:request', payload: { actionIds: ['action-1'] } };
    const pending = sendCorrelatedRpc(provider, envelope, responseSchema, { timeoutMs: 700 });

    expect(provider.sent.map((payload) => JSON.parse(payload) as unknown)).toEqual([envelope]);
    expect(provider.listeners.size).toBe(1);
    provider.emit(reply('rpc-1', 17));
    await expect(pending).resolves.toEqual({ id: 'rpc-1', type: 'test:result', ok: true, value: 17 });
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps waiting through invalid JSON, invalid schema and another request identity', async () => {
    const provider = makeProvider();
    const pending = sendCorrelatedRpc(provider, { id: 'rpc-mine', type: 'test:request' }, responseSchema, { timeoutMs: 700 });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    provider.emit('not JSON');
    provider.emit(JSON.stringify({ id: 'rpc-mine', type: 'test:result', ok: true, value: 'invalid' }));
    provider.emit(JSON.stringify({ id: 'rpc-mine', ok: true, value: 42 }));
    provider.emit(reply('rpc-other'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(provider.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    provider.emit(reply('rpc-mine'));
    await expect(pending).resolves.toEqual({ id: 'rpc-mine', type: 'test:result', ok: true, value: 42 });
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates concurrent requests and removes only the listener for the answered request', async () => {
    const provider = makeProvider();
    const first = sendCorrelatedRpc(provider, { id: 'first', type: 'test:request' }, responseSchema, { timeoutMs: 700 });
    const second = sendCorrelatedRpc(provider, { id: 'second', type: 'test:request' }, responseSchema, { timeoutMs: 700 });
    let firstSettled = false;
    void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    expect(provider.listeners.size).toBe(2);

    provider.emit(reply('second', 2));
    await expect(second).resolves.toEqual({ id: 'second', type: 'test:result', ok: true, value: 2 });
    expect(firstSettled).toBe(false);
    expect(provider.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    provider.emit(reply('first', 1));
    await expect(first).resolves.toEqual({ id: 'first', type: 'test:result', ok: true, value: 1 });
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an unanswered request at its configured deadline and releases its listener', async () => {
    const provider = makeProvider();
    const pending = sendCorrelatedRpc(provider, { id: 'timeout', type: 'test:request' }, responseSchema, { timeoutMs: 700 });
    const rejected = expect(pending).rejects.toBeInstanceOf(SpaceRpcUnanswered);

    vi.advanceTimersByTime(699);
    expect(provider.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await rejected;
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(provider.sent).toHaveLength(1);
  });

  it('releases listener and timer when sendStateless throws synchronously', async () => {
    const provider = makeProvider();
    const failure = new Error('Transport refused the send');
    provider.whenSending = () => { throw failure; };

    const pending = sendCorrelatedRpc(provider, { id: 'send-error', type: 'test:request' }, responseSchema, { timeoutMs: 700 });
    await expect(pending).rejects.toBe(failure);
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(provider.sent).toHaveLength(1);
  });

  it('does not send or install a listener when the supplied signal is already aborted', async () => {
    const provider = makeProvider();
    const abort = new AbortController();
    abort.abort();
    const add = vi.spyOn(abort.signal, 'addEventListener');

    const pending = sendCorrelatedRpc(provider, { id: 'pre-aborted', type: 'test:request' }, responseSchema, { timeoutMs: 700, signal: abort.signal });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.sent).toEqual([]);
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects an in-flight abort as AbortError and removes its provider and abort listeners', async () => {
    const provider = makeProvider();
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const pending = sendCorrelatedRpc(provider, { id: 'cancelled', type: 'test:request' }, responseSchema, { timeoutMs: 700, signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const listener = add.mock.calls.find(([event]) => event === 'abort')?.[1];
    expect(typeof listener === 'function' || typeof listener === 'object').toBe(true);

    abort.abort();
    await rejected;
    expect(remove.mock.calls.some(([event, callback]) => event === 'abort' && callback === listener)).toBe(true);
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(provider.sent).toHaveLength(1);
    provider.emit(reply('cancelled'));
    expect(provider.listeners.size).toBe(0);
  });

  it('removes the abort listener after a successful reply', async () => {
    const provider = makeProvider();
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const pending = sendCorrelatedRpc(provider, { id: 'answered', type: 'test:request' }, responseSchema, { timeoutMs: 700, signal: abort.signal });
    const listener = add.mock.calls.find(([event]) => event === 'abort')?.[1];

    provider.emit(reply('answered', 9));
    await expect(pending).resolves.toEqual({ id: 'answered', type: 'test:result', ok: true, value: 9 });
    expect(remove.mock.calls.some(([event, callback]) => event === 'abort' && callback === listener)).toBe(true);
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the abort listener after a timeout', async () => {
    const provider = makeProvider();
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const pending = sendCorrelatedRpc(provider, { id: 'unanswered', type: 'test:request' }, responseSchema, { timeoutMs: 700, signal: abort.signal });
    const rejected = expect(pending).rejects.toBeInstanceOf(SpaceRpcUnanswered);
    const listener = add.mock.calls.find(([event]) => event === 'abort')?.[1];

    vi.advanceTimersByTime(700);
    await rejected;
    expect(remove.mock.calls.some(([event, callback]) => event === 'abort' && callback === listener)).toBe(true);
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the abort listener when sending throws', async () => {
    const provider = makeProvider();
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const failure = new Error('Send failed');
    provider.whenSending = () => { throw failure; };
    const pending = sendCorrelatedRpc(provider, { id: 'send-failed', type: 'test:request' }, responseSchema, { timeoutMs: 700, signal: abort.signal });
    const listener = add.mock.calls.find(([event]) => event === 'abort')?.[1];

    await expect(pending).rejects.toBe(failure);
    expect(remove.mock.calls.some(([event, callback]) => event === 'abort' && callback === listener)).toBe(true);
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a reply emitted synchronously by sendStateless without leaving a timeout behind', async () => {
    const provider = makeProvider();
    provider.whenSending = (payload) => {
      const request = JSON.parse(payload) as { id: string };
      provider.emit(reply(request.id, 77));
    };
    const pending = sendCorrelatedRpc(provider, { id: 'synchronous', type: 'test:request' }, responseSchema, { timeoutMs: 700 });

    await expect(pending).resolves.toEqual({ id: 'synchronous', type: 'test:result', ok: true, value: 77 });
    expect(provider.sent).toHaveLength(1);
    expect(provider.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
