import { describe, it, expect, vi } from 'vitest';

import { sendSpaceRpc } from '@/data/yjs/space-rpc-client';

/**
 * Minimal stub of the slice of HocuspocusProvider that
 * {@link sendSpaceRpc} uses. We deliberately avoid the real provider —
 * it opens a WebSocket and depends on a y-protocols sync handshake we
 * cannot satisfy in jsdom.
 */
function makeStubProvider() {
  const handlers = new Set<(data: { payload: string }) => void>();
  const sent: string[] = [];
  return {
    sendStateless: (payload: string) => {
      sent.push(payload);
    },
    on: (evt: string, cb: (data: { payload: string }) => void) => {
      if (evt !== 'stateless') return;
      handlers.add(cb);
    },
    off: (evt: string, cb: (data: { payload: string }) => void) => {
      if (evt !== 'stateless') return;
      handlers.delete(cb);
    },
    /** Test helper: simulate server broadcasting back a response. */
    _emit(payload: string) {
      handlers.forEach((h) => h({ payload }));
    },
    _sent: sent,
    _handlerCount: () => handlers.size,
  };
}

type Provider = ReturnType<typeof makeStubProvider>;

describe('sendSpaceRpc', () => {
  it('serializes the request envelope and sends it via sendStateless', async () => {
    const provider = makeStubProvider();
    const promise = sendSpaceRpc(
      provider as unknown as Parameters<typeof sendSpaceRpc>[0],
      { type: 'space:delete', payload: { spaceId: 'sp-1' } },
      { idGen: () => 'rpc-1' },
    );

    expect(provider._sent).toHaveLength(1);
    const sent = JSON.parse(provider._sent[0]);
    expect(sent).toEqual({
      id: 'rpc-1',
      type: 'space:delete',
      payload: { spaceId: 'sp-1' },
    });

    provider._emit(JSON.stringify({ id: 'rpc-1', ok: true }));
    const res = await promise;
    expect(res.ok).toBe(true);
  });

  it('resolves with the response matching the correlation id', async () => {
    const provider = makeStubProvider();
    const promise = sendSpaceRpc(
      provider as unknown as Parameters<typeof sendSpaceRpc>[0],
      { type: 'space:create', payload: { spaceId: 'sp-1', type: 'canvas', name: 'Main' } },
      { idGen: () => 'rpc-A' },
    );
    provider._emit(
      JSON.stringify({
        id: 'rpc-A',
        ok: true,
        result: { spaceId: 'sp-1', type: 'canvas', name: 'Main' },
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result?.spaceId).toBe('sp-1');
    }
  });

  it('ignores responses with a non-matching id (concurrent in-flight)', async () => {
    const provider = makeStubProvider();
    const promise = sendSpaceRpc(
      provider as unknown as Parameters<typeof sendSpaceRpc>[0],
      { type: 'space:delete', payload: { spaceId: 'sp-1' } },
      { idGen: () => 'rpc-MINE' },
    );

    // Foreign response for another in-flight call — should NOT settle ours.
    provider._emit(JSON.stringify({ id: 'rpc-OTHER', ok: true }));

    // Spin micro-tasks; promise must still be pending.
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // Now ours arrives.
    provider._emit(JSON.stringify({ id: 'rpc-MINE', ok: true }));
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('rejects with a timeout error if no response arrives', async () => {
    vi.useFakeTimers();
    try {
      const provider = makeStubProvider();
      const promise = sendSpaceRpc(
        provider as unknown as Parameters<typeof sendSpaceRpc>[0],
        { type: 'space:lock', payload: { spaceId: 'sp-1', locked: true } },
        { idGen: () => 'rpc-T', timeoutMs: 1000 },
      );
      vi.advanceTimersByTime(1001);
      await expect(promise).rejects.toThrow(/timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the stateless listener on resolve (no leak)', async () => {
    const provider = makeStubProvider();
    expect(provider._handlerCount()).toBe(0);
    const promise = sendSpaceRpc(
      provider as unknown as Parameters<typeof sendSpaceRpc>[0],
      { type: 'space:delete', payload: { spaceId: 'sp-1' } },
      { idGen: () => 'rpc-L' },
    );
    expect(provider._handlerCount()).toBe(1);
    provider._emit(JSON.stringify({ id: 'rpc-L', ok: true }));
    await promise;
    expect(provider._handlerCount()).toBe(0);
  });

  it('removes the stateless listener on timeout (no leak)', async () => {
    vi.useFakeTimers();
    try {
      const provider = makeStubProvider();
      const promise = sendSpaceRpc(
        provider as unknown as Parameters<typeof sendSpaceRpc>[0],
        { type: 'space:delete', payload: { spaceId: 'sp-1' } },
        { idGen: () => 'rpc-LT', timeoutMs: 500 },
      );
      expect(provider._handlerCount()).toBe(1);
      vi.advanceTimersByTime(600);
      await expect(promise).rejects.toThrow();
      expect(provider._handlerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses an error response envelope correctly', async () => {
    const provider = makeStubProvider();
    const promise = sendSpaceRpc(
      provider as unknown as Parameters<typeof sendSpaceRpc>[0],
      { type: 'space:restore', payload: { spaceId: 'sp-1' } },
      { idGen: () => 'rpc-E' },
    );
    provider._emit(
      JSON.stringify({
        id: 'rpc-E',
        ok: false,
        error: { code: 'FORBIDDEN', message: 'owner only' },
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('FORBIDDEN');
      expect(res.error.message).toBe('owner only');
    }
  });

  it('silently ignores invalid payload (not JSON / not an SpaceRpcResponse)', async () => {
    const provider = makeStubProvider();
    const promise = sendSpaceRpc(
      provider as unknown as Parameters<typeof sendSpaceRpc>[0],
      { type: 'space:delete', payload: { spaceId: 'sp-1' } },
      { idGen: () => 'rpc-I' },
    );

    // Garbage → must not settle our promise.
    provider._emit('not json at all');
    provider._emit(JSON.stringify({ wrong: 'shape' }));
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    provider._emit(JSON.stringify({ id: 'rpc-I', ok: true }));
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  // Suppress unused-var of the type alias.
  void ({} as Provider);
});
