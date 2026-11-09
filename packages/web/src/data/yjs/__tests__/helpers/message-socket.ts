// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 6 (inner#1790 web spec 21.1, 21.2): the
 * REAL `HocuspocusProvider`, built by production `acquireDocProvider` with
 * production configuration, attached to a recording stand-in for the shared
 * WebSocket. Every frame the provider sends lands in {@link RecordingSocket}
 * `frames`, which the counting helpers decode (spec 21.1 "数法").
 *
 * Install it from a test file with
 * `vi.mock('@hocuspocus/provider', async (importOriginal) => (await import('@web/data/yjs/__tests__/helpers/message-socket')).messageSocketModule(await importOriginal()))`.
 * Like `doc-size-driver`, this module imports no production module of the
 * package: it is loaded from inside that mock factory.
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { writeSyncStep1, writeSyncStep2 } from 'y-protocols/sync';
import * as Y from 'yjs';

import { updateShape } from '@breatic/shared/update-shape';

/** What the real provider exposes that these tests read or drive. */
export interface RealProvider {
  readonly document: Y.Doc;
  readonly configuration: { name: string; flushDelay?: number; websocketProvider: RecordingSocket };
  isAuthenticated: boolean;
  authorizedScope: string | undefined;
  onMessage: (event: { data: Uint8Array }) => void;
  flushPendingUpdates: () => void;
  sendStateless: (payload: string) => void;
  receiveStateless: (payload: string) => void;
}

/** One frame the provider sent, decoded far enough to classify it. */
export type SentFrame =
  | { kind: 'update'; name: string; update: Uint8Array }
  | { kind: 'step1'; name: string }
  | { kind: 'step2'; name: string; update: Uint8Array }
  | { kind: 'stateless'; name: string; payload: string }
  | { kind: 'close'; name: string }
  | { kind: 'other'; name: string; type: number };

/** Every recording socket constructed in the current test file, in order. */
export const recordingSockets: RecordingSocket[] = [];

/**
 * Decodes one outgoing frame (routing name, message type, sync sub-type).
 * @param bytes - The frame.
 * @returns The decoded frame.
 * @throws {Error} When the frame is not a Hocuspocus message.
 */
export function decodeFrame(bytes: Uint8Array): SentFrame {
  const decoder = decoding.createDecoder(bytes);
  const name = decoding.readVarString(decoder);
  const type = decoding.readVarUint(decoder);
  if (type === 0) {
    const sub = decoding.readVarUint(decoder);
    if (sub === 0) return { kind: 'step1', name };
    const update = decoding.readVarUint8Array(decoder);
    return sub === 2 ? { kind: 'update', name, update } : { kind: 'step2', name, update };
  }
  if (type === 5) return { kind: 'stateless', name, payload: decoding.readVarString(decoder) };
  return { kind: 'other', name, type };
}

/** Recording stand-in for `HocuspocusProviderWebsocket`. */
export class RecordingSocket {
  status = 'connected';
  webSocket: { readyState: number } | null = { readyState: 1 };
  receivedOnOpenPayload: Event | undefined = undefined;
  configuration = { providerMap: new Map<string, RealProvider>() };
  /** Every frame sent, decoded, in order. */
  frames: SentFrame[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  /** Registers the socket. */
  constructor() {
    recordingSockets.push(this);
  }

  /**
   * Subscribes to a socket event.
   * @param event - Event name.
   * @param callback - Listener.
   * @returns This socket.
   */
  on(event: string, callback: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
    return this;
  }

  /**
   * Unsubscribes from a socket event.
   * @param event - Event name.
   * @param callback - Listener.
   * @returns This socket.
   */
  off(event: string, callback?: (...args: unknown[]) => void): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((c) => c !== callback));
    return this;
  }

  /**
   * Delivers a socket event to its listeners.
   * @param event - Event name.
   * @param args - Payload.
   */
  emit(event: string, ...args: unknown[]): void {
    for (const callback of [...(this.listeners.get(event) ?? [])]) callback(...args);
  }

  /**
   * Like the real socket: registers the provider, opening it when the socket already opened.
   * @param provider - The provider.
   */
  attach(provider: RealProvider): void {
    this.configuration.providerMap.set(provider.configuration.name, provider);
    if (this.receivedOnOpenPayload !== undefined) {
      void (provider as unknown as { onOpen: (event: Event) => Promise<void> }).onOpen(this.receivedOnOpenPayload);
    }
  }

  /**
   * Like the real socket: a still-mapped provider sends CLOSE and is unmapped.
   * @param provider - The provider.
   */
  detach(provider: RealProvider): void {
    const name = provider.configuration.name;
    if (!this.configuration.providerMap.has(name)) return;
    this.frames.push({ kind: 'close', name });
    this.configuration.providerMap.delete(name);
  }

  /**
   * Records one outgoing frame.
   * @param bytes - The frame.
   */
  send(bytes: Uint8Array): void {
    this.frames.push(decodeFrame(bytes));
  }

  /** Nothing to tear down. */
  destroy(): void {
    this.listeners.clear();
  }

  /**
   * The socket opens: every attached provider sends its token and SyncStep1.
   */
  open(): void {
    const event = new Event('open');
    this.receivedOnOpenPayload = event;
    this.webSocket = { readyState: 1 };
    this.emit('open', event);
  }

  /**
   * The socket drops: every attached provider runs its `onClose`.
   */
  drop(): void {
    this.receivedOnOpenPayload = undefined;
    this.webSocket = null;
    this.emit('close', { event: { code: 1006, reason: '' } });
  }

  /**
   * Delivers one incoming frame to the provider it is routed to.
   * @param bytes - The frame.
   * @throws {Error} When no provider is attached under that name.
   */
  receive(bytes: Uint8Array): void {
    const name = decoding.readVarString(decoding.createDecoder(bytes));
    const provider = this.configuration.providerMap.get(name);
    if (provider === undefined) throw new Error(`no provider attached for ${name}`);
    provider.onMessage({ data: bytes });
  }
}

/**
 * Builds the mocked `@hocuspocus/provider` module: the real provider, a recording socket.
 * @param actual - The real module.
 * @returns The module with the socket replaced.
 * @throws {never} Never.
 */
export function messageSocketModule(actual: object): object {
  return { ...actual, HocuspocusProviderWebsocket: RecordingSocket };
}

/**
 * The server authenticates the document read-write.
 * @param name - Canonical document name.
 * @returns The frame.
 * @throws {never} Never.
 */
export function authenticatedFrame(name: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarString(encoder, 'read-write');
  return encoding.toUint8Array(encoder);
}

/**
 * The server's SyncStep1, carrying the state vector of its copy.
 * @param name - Canonical document name.
 * @param server - The server's copy.
 * @returns The frame.
 * @throws {never} Never.
 */
export function step1Frame(name: string, server: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, 0);
  writeSyncStep1(encoder, server);
  return encoding.toUint8Array(encoder);
}

/**
 * The server's SyncStep2, answering the client's state vector.
 * @param name - Canonical document name.
 * @param server - The server's copy.
 * @param client - The client's document.
 * @returns The frame.
 * @throws {never} Never.
 */
export function step2Frame(name: string, server: Y.Doc, client: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, 0);
  writeSyncStep2(encoder, server, Y.encodeStateVector(client));
  return encoding.toUint8Array(encoder);
}

/**
 * A stateless frame from the server.
 * @param name - Canonical document name.
 * @param payload - The serialized payload.
 * @returns The frame.
 * @throws {never} Never.
 */
export function statelessFrame(name: string, payload: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, 5);
  encoding.writeVarString(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/** One Update message counted by {@link countMessages}, with its shape against the mirror. */
export interface CountedUpdate {
  update: Uint8Array;
  shape: 'S' | 'D' | 'R';
}

/** What a count reads: the frames a socket sent, in order. */
export interface FrameLog {
  readonly frames: readonly SentFrame[];
}

/** A running count of one document's Update messages. */
export interface MessageCount {
  /** The Update messages sent since the count started, judged in order. */
  updates: () => CountedUpdate[];
  /** Every frame of the document sent since the count started. */
  frames: () => SentFrame[];
  /** Whether the mirror, with every counted update applied, equals the document. */
  mirrorMatches: () => boolean;
}

/**
 * Starts counting the Update messages one document sends on a socket. Each
 * is judged by shared `updateShape` against a `gc: false` mirror of the
 * document taken now, then applied to it (spec 21.1, 0.4).
 * @param socket - The socket's frame log.
 * @param name - Canonical document name.
 * @param doc - The document.
 * @returns The count.
 * @throws {never} Never.
 */
export function countMessages(socket: FrameLog, name: string, doc: Y.Doc): MessageCount {
  const start = socket.frames.length;
  const mirror = new Y.Doc({ gc: false });
  Y.applyUpdate(mirror, Y.encodeStateAsUpdate(doc));
  const judged: CountedUpdate[] = [];
  let seen = start;
  /** Judges and applies the frames sent since the last read. */
  const catchUp = (): void => {
    for (; seen < socket.frames.length; seen += 1) {
      const frame = socket.frames[seen]!;
      if (frame.kind !== 'update' || frame.name !== name) continue;
      const shape = updateShape(frame.update, mirror.store);
      judged.push({ update: frame.update, shape: !shape.pureDelete ? 'S' : shape.wholeTypesOnly ? 'R' : 'D' });
      Y.applyUpdate(mirror, frame.update);
    }
  };
  return {
    updates: (): CountedUpdate[] => { catchUp(); return [...judged]; },
    frames: (): SentFrame[] => socket.frames.slice(start).filter((frame) => frame.name === name),
    mirrorMatches: (): boolean => {
      catchUp();
      return Y.equalSnapshots(Y.snapshot(mirror), Y.snapshot(doc));
    },
  };
}

/**
 * Waits on real timers until the provider's send window has long passed
 * (spec 21.1: at least 50 ms after the operation), letting microtasks,
 * React's scheduler and any timers run in between.
 * @returns Resolves when idle.
 * @throws {never} Never.
 */
export async function idle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
