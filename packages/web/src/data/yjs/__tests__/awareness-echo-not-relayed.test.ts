// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A client must not send back the presence it just received.
 *
 * Presence travels as awareness, and every client holds the whole room's
 * awareness locally — mine plus everyone else's. The provider forwards local
 * awareness changes to the server off the one `update` event that fires for
 * BOTH kinds of change: the ones this tab made, and the ones that just arrived
 * from the server. Forward both and every client sends each change it receives
 * straight back, so one person moving costs the room one echo per other
 * member — the traffic, not any single frame, is what grows with the square of
 * the room.
 *
 * The signal that separates them is the `origin` y-protocols passes with the
 * event, and hocuspocus 3.4.4 took that argument and never read it. 4.5.0
 * opens the handler with `if (origin === this) return`, and applies inbound
 * awareness with the provider itself as origin, so the two line up exactly.
 * We moved to 4.5.0 on 2026-08-06.
 *
 * These cases pin that, because somebody else's code is holding it up and
 * nothing in this repo would notice it going away — a downgrade, a resolution
 * change, or an upstream regression all look like silence.
 *
 * ## Where the measurement is taken
 *
 * On the bytes the socket is handed, decoded back into "which clients does
 * this frame name". Taking it one level up, at the arguments of
 * `provider.send`, would leave the encoder unmeasured: an `AwarenessMessage`
 * that ignored those arguments and encoded the whole room would reproduce the
 * very symptom being pinned here, with every case still green. Reaching the
 * bytes costs one line — `provider.attach()`, because `send` returns early
 * while detached — and it puts these cases on the same footing as the browser
 * run, which also read the wire.
 *
 * Each case pairs its silence with an assertion that the remote frame landed.
 * Silence alone cannot tell "the echo was suppressed" from "nothing arrived",
 * and a frame stops landing for ordinary reasons — an encoding change, a
 * stricter clock rule upstream.
 *
 * ## What these cases do NOT say
 *
 * That a frame from a client only ever names that client. The last case shows
 * one that names somebody else: a removal this client decided on its own,
 * which carries a `'timeout'` origin rather than the provider and so is
 * forwarded.
 *
 * What the server does about that is settled and is the opposite of a
 * per-entry ownership question: it writes the identity it authenticated onto
 * every entry it is handed, and asking whose an entry is has been banned
 * outright (`packages/collab/CLAUDE.md`, #1887). This particular frame never
 * reaches that rule anyway — the server applies an inbound frame to a scratch
 * awareness first, and a removal deletes the entry from it, so there is
 * nothing left to hand over.
 *
 * That removal is the one y-protocols' own sweep issues for a peer it has not
 * heard from in thirty seconds (`awareness.js:70-75`) — read there, not
 * measured here. The sweep is out of reach of a test: y-protocols reads the
 * clock through lib0's `getUnixTime`, which is `Date.now` captured at module
 * load, so a faked `Date` never moves it and the sweep never fires. The case
 * below makes the call the sweep makes, arguments and all, which is as close
 * as a test gets and is how the sibling bfcache suite handles the same problem.
 */

import { HocuspocusProvider, MessageType } from '@hocuspocus/provider';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

const DOC_NAME = 'canvas.echo-probe';

/** One outgoing awareness frame, reduced to what these cases decide on. */
interface Frame {
  /** Document the frame is addressed to. */
  doc: string;
  /** Awareness client ids the frame names. */
  clients: number[];
}

/**
 * Decode an outgoing frame far enough to name its clients.
 *
 * @param bytes - Exactly what the provider handed the socket.
 * @returns The frame, or null when it is not an awareness frame.
 */
function decodeAwarenessFrame(bytes: Uint8Array): Frame | null {
  const outer = decoding.createDecoder(bytes);
  const doc = decoding.readVarString(outer);
  if (decoding.readVarUint(outer) !== MessageType.Awareness) return null;
  const update = decoding.createDecoder(decoding.readVarUint8Array(outer));
  const count = decoding.readVarUint(update);
  const clients: number[] = [];
  for (let i = 0; i < count; i += 1) {
    clients.push(decoding.readVarUint(update));
    decoding.readVarUint(update); // clock
    decoding.readVarString(update); // state, as JSON
  }
  return { doc, clients };
}

/**
 * Encode the frame a server sends when another client's presence changed.
 *
 * @param peer - Awareness standing in for the other client.
 * @returns The wire bytes, outer envelope included.
 */
function remotePresenceFrame(peer: Awareness): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, DOC_NAME);
  encoding.writeVarUint(enc, MessageType.Awareness);
  encoding.writeVarUint8Array(
    enc,
    encodeAwarenessUpdate(peer, [peer.clientID]),
  );
  return encoding.toUint8Array(enc);
}

/** Everything one case needs, torn down together. */
interface Harness {
  provider: HocuspocusProvider;
  /** Awareness of a second client, never attached to this provider. */
  peer: Awareness;
  /** Every awareness frame the socket was handed, in order. */
  sent: Frame[];
}

const built: Harness[] = [];

/**
 * Build a real provider over a socket that records instead of connecting.
 *
 * @returns The harness, registered for teardown.
 */
function harness(): Harness {
  const sent: Frame[] = [];
  const socket = {
    attach: vi.fn(),
    detach: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    send: (bytes: Uint8Array): void => {
      const frame = decodeAwarenessFrame(bytes);
      if (frame) sent.push(frame);
    },
  };
  const provider = new HocuspocusProvider({
    websocketProvider: socket as never,
    name: DOC_NAME,
    document: new Y.Doc(),
    token: 'test-token',
  });
  // `send` returns early while detached, so nothing would reach the socket.
  // Attaching only registers listeners on the stub, which never emits.
  provider.attach();
  const h: Harness = { provider, peer: new Awareness(new Y.Doc()), sent };
  built.push(h);
  return h;
}

afterEach(() => {
  for (const h of built.splice(0)) {
    h.peer.destroy();
    h.provider.destroy();
  }
  vi.restoreAllMocks();
});

describe('awareness — a client does not relay back what it received', () => {
  it('sends nothing when another client\'s presence arrives from the server', () => {
    const { provider, peer, sent } = harness();
    peer.setLocalStateField('user', { id: 'somebody-else' });

    provider.onMessage({ data: remotePresenceFrame(peer) } as MessageEvent);

    // The state did land — this client knows about the peer...
    expect(provider.awareness?.getStates().get(peer.clientID)).toEqual({
      user: { id: 'somebody-else' },
    });
    // ...and told the server nothing about it.
    expect(sent).toEqual([]);
  });

  it('sends its own presence change, so the measurement point is live', () => {
    const { provider, sent } = harness();

    provider.awareness?.setLocalStateField('user', { id: 'me' });

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.flatMap((f) => f.clients)).toEqual([
      provider.awareness?.clientID,
    ]);
    expect(sent.every((f) => f.doc === DOC_NAME)).toBe(true);
  });

  it('still relays nothing after a whole round of remote traffic', () => {
    const { provider, peer, sent } = harness();

    for (let i = 0; i < 5; i += 1) {
      peer.setLocalStateField('cursor', { at: i });
      provider.onMessage({ data: remotePresenceFrame(peer) } as MessageEvent);
      // Checked every round rather than once at the end: the final state alone
      // would also be reached if the first four had been dropped as stale, and
      // then the silence below would be measuring a round that never happened.
      expect(provider.awareness?.getStates().get(peer.clientID)).toEqual({
        cursor: { at: i },
      });
    }

    expect(sent).toEqual([]);
  });

  it('forwards a removal it decided locally, naming the peer it removed', () => {
    const { provider, peer, sent } = harness();
    peer.setLocalStateField('user', { id: 'goes-quiet' });
    provider.onMessage({ data: remotePresenceFrame(peer) } as MessageEvent);
    expect(provider.awareness?.getStates().has(peer.clientID)).toBe(true);
    expect(sent).toEqual([]);

    // The call y-protocols' sweep makes when a peer has gone quiet
    // (`awareness.js:75`), arguments and all.
    removeAwarenessStates(
      provider.awareness as Awareness,
      [peer.clientID],
      'timeout',
    );

    // Exactly the peer, nobody else. This is the case that would catch an
    // encoder which ignored the client list and dumped the whole room: the
    // room holds this client too, so a room-wide frame would not be equal.
    expect(sent.flatMap((f) => f.clients)).toEqual([peer.clientID]);
  });
});
