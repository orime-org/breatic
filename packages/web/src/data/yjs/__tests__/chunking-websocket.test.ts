// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The browser side of collab chunking (inner#1585): a message over the
 * single-frame cap leaves the shared socket as a declaration plus chunks,
 * everything else leaves unchanged, and the provider's offline queue goes
 * through the same `send`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HocuspocusProviderWebsocket } from '@hocuspocus/provider';

/** A stand-in for the browser WebSocket that records what is handed to `send`. */
class FakeBase extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeBase[] = [];
  readonly url: string;
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];

  /**
   * Record the instance.
   * @param url - Target URL.
   */
  constructor(url: string) {
    super();
    this.url = url;
    FakeBase.instances.push(this);
  }

  /**
   * Record one outgoing frame.
   * @param data - What the caller sent.
   */
  send(data: unknown): void {
    this.sent.push(data);
  }

  /** Close without a network. */
  close(): void {
    this.readyState = 3;
  }
}

/**
 * Deterministic pseudo-random bytes.
 * @param n - Length.
 * @returns The bytes.
 */
function msg(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 7;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/**
 * Concatenate the binary frames.
 * @param frames - Frames as sent.
 * @returns The joined bytes.
 */
function joined(frames: unknown[]): Uint8Array {
  const parts = frames.filter((f): f is Uint8Array => f instanceof Uint8Array);
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

type ChunkingCtor = new (url: string) => FakeBase;

/**
 * Load the module under test against the fake base class.
 * @returns The ChunkingWebSocket class.
 */
async function load(): Promise<ChunkingCtor> {
  vi.resetModules();
  const mod = await import('@web/data/yjs/chunking-websocket');
  return mod.ChunkingWebSocket as unknown as ChunkingCtor;
}

describe('ChunkingWebSocket', () => {
  beforeEach(() => {
    FakeBase.instances = [];
    vi.stubGlobal('WebSocket', FakeBase);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('WU01 splits a Uint8Array one byte over the cap into a declaration and two chunks', async () => {
    const Chunking = await load();
    const ws = new Chunking('ws://x/');
    const m = msg(131_073);
    ws.send(m);
    expect(ws.sent).toHaveLength(3);
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'chunked', bytes: 131073 });
    expect((ws.sent[1] as Uint8Array).byteLength).toBe(131_072);
    expect((ws.sent[2] as Uint8Array).byteLength).toBe(1);
    expect(joined(ws.sent)).toEqual(m);
  });

  it('WU02 sends a Uint8Array of exactly the cap as one unchanged frame', async () => {
    const Chunking = await load();
    const ws = new Chunking('ws://x/');
    const m = msg(131_072);
    ws.send(m);
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toEqual(m);
  });

  it.each([0, 2_048])('WU03 sends a %i-byte Uint8Array as one unchanged frame', async (n) => {
    const Chunking = await load();
    const ws = new Chunking('ws://x/');
    const m = msg(n);
    ws.send(m);
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toEqual(m);
  });

  it('WU04 sends a long string unchanged', async () => {
    const Chunking = await load();
    const ws = new Chunking('ws://x/');
    const s = 'a'.repeat(200_000);
    ws.send(s);
    expect(ws.sent).toEqual([s]);
  });

  it('WU05 splits a 1.2 MB paste into a declaration and ten chunks', async () => {
    const Chunking = await load();
    const ws = new Chunking('ws://x/');
    const m = msg(1_200_000);
    ws.send(m);
    expect(ws.sent).toHaveLength(11);
    expect(joined(ws.sent)).toEqual(m);
  });

  it.each([
    ['ArrayBuffer', (): unknown => new ArrayBuffer(200_000)],
    ['DataView', (): unknown => new DataView(new ArrayBuffer(200_000))],
    ['Int8Array', (): unknown => new Int8Array(200_000)],
    ['Blob', (): unknown => new Blob([new Uint8Array(200_000)])],
  ])('WU06 hands a large %s to the base send unchanged', async (_label, make) => {
    const Chunking = await load();
    const ws = new Chunking('ws://x/');
    const data = make();
    ws.send(data);
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBe(data);
  });

  it('WU07 chunks a large message the provider queued while offline once the socket opens', async () => {
    const Chunking = await load();
    const provider = new HocuspocusProviderWebsocket({
      url: 'ws://x/',
      WebSocketPolyfill: Chunking,
      autoConnect: false,
    });
    try {
      const m = msg(300_000);
      provider.send(m);
      void provider.connect();
      await vi.waitFor(() => expect(FakeBase.instances).toHaveLength(1));
      const socket = FakeBase.instances[0]!;
      socket.readyState = 1;
      socket.dispatchEvent(new Event('open'));
      // The provider flushes its queue on the first message it receives.
      socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([9]).buffer }));
      const start = socket.sent.findIndex((f) => typeof f === 'string');
      expect(start).toBeGreaterThanOrEqual(0);
      const run = socket.sent.slice(start, start + 4);
      expect(JSON.parse(run[0] as string)).toEqual({ type: 'chunked', bytes: 300000 });
      expect(run.slice(1).map((f) => (f as Uint8Array).byteLength)).toEqual([131_072, 131_072, 37_856]);
      expect(joined(run)).toEqual(m);
      expect(socket.sent.some((f) => f instanceof Uint8Array && f.byteLength === 300_000)).toBe(false);
    } finally {
      provider.destroy();
    }
  });
});
