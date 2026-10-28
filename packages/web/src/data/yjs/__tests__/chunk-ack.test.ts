// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * collab answers each accepted declaration and chunk with `COLLAB_CHUNK_ACK`
 * (inner#1585). The browser relies on the real provider treating it as a sign
 * of life and nothing more; this pins that against provider upgrades.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { COLLAB_CHUNK_ACK } from '@breatic/shared';

/** A socket the provider drives; the test plays the server. */
class FakeSocket {
  static last: FakeSocket | undefined;
  readyState = 0;
  binaryType = 'arraybuffer';
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(name: string, cb: (e: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
  }

  removeEventListener(name: string, cb: (e: unknown) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((l) => l !== cb));
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  fire(name: string, e: unknown): void {
    for (const cb of this.listeners.get(name) ?? []) cb(e);
  }
}

const sockets: HocuspocusProviderWebsocket[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
});

describe('chunk acknowledgement', () => {
  it('WU11 refreshes the provider liveness clock and reaches no document', async () => {
    const socket = new HocuspocusProviderWebsocket({ url: 'ws://collab.test', WebSocketPolyfill: FakeSocket });
    sockets.push(socket);
    const doc = new HocuspocusProvider({ websocketProvider: socket, name: 'project-p1/canvas-s1', document: new Y.Doc() });
    doc.attach();
    const ws = FakeSocket.last!;
    ws.readyState = 1;
    ws.fire('open', {});
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    const onDocMessage = vi.fn();
    doc.on('message', onDocMessage);
    const sentBefore = ws.sent.length;
    socket.lastMessageReceived = 0;
    ws.fire('message', { data: COLLAB_CHUNK_ACK.slice().buffer });

    expect(socket.lastMessageReceived).toBeGreaterThan(0);
    expect(onDocMessage).not.toHaveBeenCalled();
    expect(ws.sent.length).toBe(sentBefore);
    doc.destroy();
  });
});
