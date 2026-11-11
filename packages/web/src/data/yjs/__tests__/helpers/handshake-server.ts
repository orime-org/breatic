// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790 web spec 23.0, `H7`): a
 * scripted collab server behind a stand-in for the browser's `WebSocket`.
 *
 * Everything above the browser socket is production: `acquireDocProvider`
 * builds the real `HocuspocusProvider` on the real
 * `HocuspocusProviderWebsocket`, which dials through `ChunkingWebSocket`.
 * `ChunkingWebSocket` extends the global `WebSocket` when its module is
 * evaluated, so a test file installs the stand-in before any import:
 *
 * ```ts
 * const h7 = await vi.hoisted(async () => {
 *   const m = await import('@web/data/yjs/__tests__/helpers/handshake-server');
 *   m.installScriptedWebSocket();
 *   return m;
 * });
 * afterAll(() => h7.uninstallScriptedWebSocket());
 * ```
 *
 * The server answers the Auth frame with `authenticated` (scope
 * `read-write` unless set otherwise), the client's SyncStep1 with its own
 * SyncStep1 and then SyncStep2 (the order of Hocuspocus 4.6.0's
 * `readSyncMessage`, spec 25.2), and every `sync:confirm` with
 * `sync:confirmed { ok: true }`; it never answers `doc:size-seen`. It sends
 * `doc:size` pushes and peers' updates when a case asks. Every frame a client
 * sends is recorded in arrival order (spec 23.0 "帧记录").
 *
 * `H9` (spec 25.0) is the same server with {@link ScriptedServer.stepping}
 * on: `authenticated` and the two server sync steps wait until a case
 * releases them, and {@link ScriptedWebSocket.drop} drops a connection the
 * way a network failure does (code 1006).
 *
 * A case can also send a SyncStatus frame when it chooses
 * ({@link ScriptedServer.syncStatus}; the default script never sends one) and
 * a document CLOSE that lands in the case's own task, and
 * {@link recordProviderEvents} records the provider's events (spec 26.0).
 *
 * This module imports no production module of the package.
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { expect } from 'vitest';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';

import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from '@breatic/shared';
import { updateShape } from '@breatic/shared/update-shape';

/** One frame a client sent, decoded (the `SentFrame` vocabulary of `message-socket.ts`, plus the handshake kinds). */
export type ClientFrame =
  | { kind: 'update'; name: string; update: Uint8Array; shape: 'S' | 'D' | 'R' }
  | { kind: 'step1'; name: string }
  | { kind: 'step2'; name: string; update: Uint8Array }
  | { kind: 'stateless'; name: string; payload: string }
  | { kind: 'auth'; name: string }
  | { kind: 'close'; name: string }
  | { kind: 'other'; name: string; type: number };

/** A frame as spec 23.0 names it: `update`, `confirm`, `seen(seq)` or something else. */
export type FrameKind = 'update' | 'confirm' | `seen(${number})` | 'other';

/** A frame as spec 25.0 orders them: 23.0's kinds plus the handshake's `auth`, `step1` and `step2`. */
export type HandshakeKind = 'auth' | 'step1' | 'step2' | Exclude<FrameKind, 'other'>;

/** The server frames `H9` holds until a case releases them. */
export type HeldFrame = 'authenticated' | 'serverStep1' | 'serverStep2';

/** What the server pushes about a document's size, without `type` and `seq`. */
export interface SizeFixture {
  bytes: number;
  limit: number;
  ceiling: number;
  phase: 'normal' | 'warning' | 'full';
}

/** A client frame, with the connection it came on. */
export interface Recorded {
  socket: ScriptedWebSocket;
  frame: ClientFrame;
}

/** Per document, on the server. */
interface ServerDoc {
  doc: Y.Doc;
  /** The phase of each push by its `seq`. */
  pushed: Map<number, 'normal' | 'warning' | 'full'>;
  nextSeq: number;
  /**
   * Per connection, whether its last acknowledged push was full (collab's
   * `knowsFull`); a connection that authenticates again starts without one.
   */
  knowsFull: Map<ScriptedWebSocket, boolean>;
}

/**
 * Decodes one frame a client sent.
 * @param bytes - The frame.
 * @returns The routing name, the message type and a decoder positioned after it.
 * @throws {Error} When the frame is not a Hocuspocus message.
 */
function head(bytes: Uint8Array): { name: string; type: number; decoder: decoding.Decoder } {
  const decoder = decoding.createDecoder(bytes);
  const name = decoding.readVarString(decoder);
  const type = decoding.readVarUint(decoder);
  return { name, type, decoder };
}

/**
 * The bytes of a value a socket was sent.
 * @param data - What `send` received.
 * @returns The bytes, or null for a string.
 * @throws {never} Never.
 */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** The scripted collab server every stand-in socket connects to. */
export class ScriptedServer {
  /** Every connection, in the order they were opened. */
  readonly sockets: ScriptedWebSocket[] = [];
  /** Every frame clients sent, in arrival order. */
  readonly frames: Recorded[] = [];
  /** The scope each document is authorized with (default `read-write`). */
  readonly scopes = new Map<string, string>();
  /** Answer `sync:confirm` (default true). */
  autoConfirm = true;
  /**
   * Refuse like collab: once a connection acknowledged a full push, an
   * Update that is not a pure deletion on that connection closes the
   * document with `COLLAB_DOCUMENT_TOO_LARGE_REASON` and is not applied.
   */
  enforceFull = false;
  /** How many Updates the server refused. */
  refusals = 0;
  /** Called synchronously for every frame a client sends, before the server handles it. */
  onFrame: ((frame: ClientFrame, socket: ScriptedWebSocket) => void) | null = null;
  /** `H9`'s single-step mode: hold `authenticated` and the server's sync steps until {@link release}. */
  stepping = false;
  /** The frames held in single-step mode, oldest first. */
  private held: Array<{ socket: ScriptedWebSocket; name: string; label: HeldFrame; bytes: Uint8Array }> = [];
  private docs = new Map<string, ServerDoc>();
  /** Which documents each connection has authenticated. */
  private attached = new Map<ScriptedWebSocket, Set<string>>();

  /**
   * The server's copy of a document, created empty on first use.
   * @param name - Canonical document name.
   * @returns The record.
   * @throws {never} Never.
   */
  private entry(name: string): ServerDoc {
    let found = this.docs.get(name);
    if (found === undefined) {
      found = { doc: new Y.Doc({ gc: false }), pushed: new Map(), nextSeq: 1, knowsFull: new Map() };
      this.docs.set(name, found);
    }
    return found;
  }

  /**
   * The server's copy of a document.
   * @param name - Canonical document name.
   * @returns The copy (`gc: false`), the mirror every Update is judged against.
   * @throws {never} Never.
   */
  docOf(name: string): Y.Doc {
    return this.entry(name).doc;
  }

  /**
   * Seeds the server's copy (before the client opens it, its content then arrives in SyncStep2).
   * @param name - Canonical document name.
   * @param update - The content.
   * @throws {never} Never.
   */
  seed(name: string, update: Uint8Array): void {
    Y.applyUpdate(this.entry(name).doc, update);
  }

  /**
   * A connection opened.
   * @param socket - The connection.
   * @throws {never} Never.
   */
  connect(socket: ScriptedWebSocket): void {
    this.sockets.push(socket);
    this.attached.set(socket, new Set());
  }

  /**
   * The connections a document is attached on.
   * @param name - Canonical document name.
   * @returns The open connections.
   * @throws {never} Never.
   */
  private socketsOf(name: string): ScriptedWebSocket[] {
    return this.sockets.filter((socket) => socket.readyState === ScriptedWebSocket.OPEN && this.attached.get(socket)?.has(name) === true);
  }

  /**
   * Sends one frame to a connection, as a later network event.
   * @param socket - The connection.
   * @param build - Writes the frame after its routing name.
   * @param name - Canonical document name.
   * @param now - Deliver synchronously instead of on a later task.
   * @param label - What a held frame is called in single-step mode.
   * @throws {never} Never.
   */
  private send(socket: ScriptedWebSocket, name: string, build: (encoder: encoding.Encoder) => void, now = false, label?: HeldFrame): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, name);
    build(encoder);
    const bytes = encoding.toUint8Array(encoder);
    if (this.stepping && label !== undefined) this.held.push({ socket, name, label, bytes });
    else if (now) socket.deliver(bytes);
    else setTimeout(() => { socket.deliver(bytes); }, 0);
  }

  /**
   * Handles one frame a client sent.
   * @param socket - The connection.
   * @param data - What the client sent.
   * @throws {Error} When a frame cannot be decoded.
   */
  receive(socket: ScriptedWebSocket, data: unknown): void {
    const bytes = bytesOf(data);
    if (bytes === null) return;
    // A connection-level Pong carries no routing name.
    if (bytes.length === 1) return;
    const { name, type, decoder } = head(bytes);
    const server = this.entry(name);
    let frame: ClientFrame;
    if (type === 0) {
      const sub = decoding.readVarUint(decoder);
      if (sub === 0) frame = { kind: 'step1', name };
      else {
        const update = decoding.readVarUint8Array(decoder);
        if (sub === 2) {
          const shape = updateShape(update, server.doc.store);
          frame = { kind: 'update', name, update, shape: !shape.pureDelete ? 'S' : shape.wholeTypesOnly ? 'R' : 'D' };
        } else frame = { kind: 'step2', name, update };
      }
    } else if (type === 2) frame = { kind: 'auth', name };
    else if (type === 5) frame = { kind: 'stateless', name, payload: decoding.readVarString(decoder) };
    else if (type === 7) frame = { kind: 'close', name };
    else frame = { kind: 'other', name, type };
    this.onFrame?.(frame, socket);
    this.frames.push({ socket, frame });
    this.handle(socket, frame, bytes, server);
  }

  /**
   * Answers one frame the way the script says.
   * @param socket - The connection.
   * @param frame - The decoded frame.
   * @param bytes - The raw frame.
   * @param server - The document's record.
   * @throws {Error} When a sync message cannot be decoded.
   */
  private handle(socket: ScriptedWebSocket, frame: ClientFrame, bytes: Uint8Array, server: ServerDoc): void {
    const { name } = frame;
    if (frame.kind === 'auth') {
      this.attached.get(socket)?.add(name);
      server.knowsFull.delete(socket);
      const scope = this.scopes.get(name) ?? 'read-write';
      this.send(socket, name, (encoder) => {
        encoding.writeVarUint(encoder, 2);
        encoding.writeVarUint(encoder, 2);
        encoding.writeVarString(encoder, scope);
      }, false, 'authenticated');
      return;
    }
    if (frame.kind === 'close') {
      this.attached.get(socket)?.delete(name);
      return;
    }
    if (frame.kind === 'step1') {
      // The server's SyncStep1, then the SyncStep2 answering the client's
      // state vector: Hocuspocus 4.6.0 `readSyncMessage` sends the first and
      // `apply` the second (spec 25.2).
      const { decoder } = head(bytes);
      const reply = encoding.createEncoder();
      readSyncMessage(decoder, reply, server.doc, this);
      const step2 = encoding.toUint8Array(reply);
      this.send(socket, name, (encoder) => {
        encoding.writeVarUint(encoder, 0);
        writeSyncStep1(encoder, server.doc);
      }, false, 'serverStep1');
      this.send(socket, name, (encoder) => {
        encoding.writeVarUint(encoder, 0);
        encoding.writeUint8Array(encoder, step2);
      }, false, 'serverStep2');
      return;
    }
    if (frame.kind === 'step2') {
      Y.applyUpdate(server.doc, frame.update, socket);
      return;
    }
    if (frame.kind === 'update') {
      if (this.enforceFull && server.knowsFull.get(socket) === true && frame.shape === 'S') {
        this.refusals += 1;
        this.closeDocument(name, COLLAB_DOCUMENT_TOO_LARGE_REASON);
        return;
      }
      Y.applyUpdate(server.doc, frame.update, socket);
      return;
    }
    if (frame.kind !== 'stateless') return;
    let body: { type?: unknown; id?: unknown; seq?: unknown };
    try {
      body = JSON.parse(frame.payload) as typeof body;
    } catch {
      return;
    }
    if (body.type === 'sync:confirm' && this.autoConfirm && typeof body.id === 'string') {
      const payload = JSON.stringify({ type: 'sync:confirmed', id: body.id, ok: true });
      this.send(socket, name, (encoder) => {
        encoding.writeVarUint(encoder, 5);
        encoding.writeVarString(encoder, payload);
      });
    }
    if (body.type === 'doc:size-seen' && typeof body.seq === 'number') {
      const phase = server.pushed.get(body.seq);
      if (phase !== undefined) server.knowsFull.set(socket, phase === 'full');
    }
  }

  /**
   * Pushes a document's size to every connection it is open on, synchronously
   * (the push is handled before this returns).
   * @param name - Canonical document name.
   * @param fixture - The push.
   * @param seq - Its sequence number; the next one when omitted.
   * @returns The sequence number sent.
   * @throws {never} Never.
   */
  push(name: string, fixture: SizeFixture, seq?: number): number {
    const server = this.entry(name);
    const sent = seq ?? server.nextSeq;
    server.nextSeq = Math.max(server.nextSeq, sent + 1);
    server.pushed.set(sent, fixture.phase);
    this.pushRaw(name, JSON.stringify({ type: 'doc:size', seq: sent, ...fixture }));
    return sent;
  }

  /**
   * Sends a raw stateless payload, synchronously.
   * @param name - Canonical document name.
   * @param payload - The payload.
   * @throws {never} Never.
   */
  pushRaw(name: string, payload: string): void {
    for (const socket of this.socketsOf(name)) {
      this.send(socket, name, (encoder) => {
        encoding.writeVarUint(encoder, 5);
        encoding.writeVarString(encoder, payload);
      }, true);
    }
  }

  /**
   * A peer's change: applied to the server's copy and sent to every connection the document is open on.
   * @param name - Canonical document name.
   * @param change - What the peer does to its own copy of the server's document.
   * @throws {never} Never.
   */
  peer(name: string, change: (peer: Y.Doc) => void): void {
    const server = this.entry(name);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server.doc));
    const vector = Y.encodeStateVector(server.doc);
    change(peer);
    const update = Y.encodeStateAsUpdate(peer, vector);
    peer.destroy();
    Y.applyUpdate(server.doc, update, 'peer');
    for (const socket of this.socketsOf(name)) {
      this.send(socket, name, (encoder) => {
        encoding.writeVarUint(encoder, 0);
        writeUpdate(encoder, update);
      }, true);
    }
  }

  /**
   * Closes one document on every connection (a Hocuspocus CLOSE message);
   * the connection itself stays open.
   * @param name - Canonical document name.
   * @param reason - The close reason.
   * @param now - Deliver synchronously instead of on a later task, so a frame
   * the case sends right after it lands in the same task (spec 26.0).
   * @throws {never} Never.
   */
  closeDocument(name: string, reason: string, now = false): void {
    for (const socket of this.socketsOf(name)) {
      this.attached.get(socket)?.delete(name);
      this.send(socket, name, (encoder) => {
        encoding.writeVarUint(encoder, 7);
        encoding.writeVarString(encoder, reason);
      }, now);
    }
  }

  /**
   * Sends a SyncStatus frame for a document, synchronously, encoded as
   * Hocuspocus 4.6.0 `writeSyncStatus` (spec 26.0). Like the real server's
   * `Connection.send` it goes to every open connection whether or not the
   * document is still open on it, so it can reach the provider of a
   * reopened or rebuilt document.
   * @param name - Canonical document name.
   * @param applied - 1 when the server applied the client's sync message, 0 when it did not.
   * @throws {never} Never.
   */
  syncStatus(name: string, applied: 0 | 1): void {
    for (const socket of this.sockets.filter((open) => open.readyState === ScriptedWebSocket.OPEN)) {
      this.send(socket, name, (encoder) => {
        encoding.writeVarUint(encoder, 8);
        encoding.writeVarUint(encoder, applied);
      }, true);
    }
  }

  /**
   * Delivers the oldest held frame of a kind for a document on an open
   * connection, synchronously (single-step mode, spec 25.0).
   * @param label - Which frame.
   * @param name - Canonical document name.
   * @throws {Error} When no such frame is held.
   */
  release(label: HeldFrame, name: string): void {
    const at = this.held.findIndex((held) => held.label === label && held.name === name && held.socket.readyState === ScriptedWebSocket.OPEN);
    if (at === -1) throw new Error(`no ${label} is held for ${name}`);
    const [held] = this.held.splice(at, 1);
    held!.socket.deliver(held!.bytes);
  }

  /**
   * Whether a frame of a kind is held for a document on an open connection.
   * @param label - Which frame.
   * @param name - Canonical document name.
   * @returns Whether {@link release} would deliver one.
   * @throws {never} Never.
   */
  holds(label: HeldFrame, name: string): boolean {
    return this.held.some((held) => held.label === label && held.name === name && held.socket.readyState === ScriptedWebSocket.OPEN);
  }

  /**
   * One document's frames since an index, as spec 25.0 orders them: the
   * handshake's and spec 23.0's kinds, without awareness and other frames.
   * @param name - Canonical document name.
   * @param from - The first index into {@link frames}.
   * @param socket - Only the frames of this connection.
   * @returns The kinds, in arrival order.
   * @throws {never} Never.
   */
  order(name: string, from = 0, socket?: ScriptedWebSocket): HandshakeKind[] {
    const out: HandshakeKind[] = [];
    for (const recorded of this.frames.slice(from)) {
      if (recorded.frame.name !== name || (socket !== undefined && recorded.socket !== socket)) continue;
      const { frame } = recorded;
      const kind = frame.kind === 'auth' || frame.kind === 'step1' || frame.kind === 'step2' ? frame.kind : kindOf(frame);
      if (kind !== 'other') out.push(kind);
    }
    return out;
  }

  /**
   * One document's frames since an index, as spec 23.0 names them.
   * @param name - Canonical document name.
   * @param from - The first index into {@link frames}.
   * @returns The kinds, in arrival order.
   * @throws {never} Never.
   */
  kinds(name: string, from = 0): FrameKind[] {
    return this.frames.slice(from).filter(({ frame }) => frame.name === name).map(({ frame }) => kindOf(frame));
  }

  /**
   * The Update frames of one document since an index.
   * @param name - Canonical document name.
   * @param from - The first index into {@link frames}.
   * @returns The updates with their shapes.
   * @throws {never} Never.
   */
  updates(name: string, from = 0): Array<{ update: Uint8Array; shape: 'S' | 'D' | 'R' }> {
    const out: Array<{ update: Uint8Array; shape: 'S' | 'D' | 'R' }> = [];
    for (const { frame } of this.frames.slice(from)) {
      if (frame.kind === 'update' && frame.name === name) out.push({ update: frame.update, shape: frame.shape });
    }
    return out;
  }

  /**
   * The index the next recorded frame will have.
   * @returns The index.
   * @throws {never} Never.
   */
  mark(): number {
    return this.frames.length;
  }

  /**
   * The frames in the `SentFrame` vocabulary of `message-socket.ts`, so its
   * `countMessages` reads them (an `update` judged against a mirror it takes).
   * @returns The frames.
   * @throws {never} Never.
   */
  get sentFrames(): Array<Exclude<ClientFrame, { kind: 'auth' }> | { kind: 'other'; name: string; type: number }> {
    return this.frames.map(({ frame }) => (frame.kind === 'auth' ? { kind: 'other' as const, name: frame.name, type: 2 } : frame));
  }
}

/**
 * A frame's spec 23.0 name.
 * @param frame - The frame.
 * @returns `update`, `confirm`, `seen(seq)` or `other`.
 * @throws {never} Never.
 */
export function kindOf(frame: ClientFrame): FrameKind {
  if (frame.kind === 'update') return 'update';
  if (frame.kind !== 'stateless') return 'other';
  try {
    const body = JSON.parse(frame.payload) as { type?: unknown; seq?: unknown };
    if (body.type === 'sync:confirm') return 'confirm';
    if (body.type === 'doc:size-seen' && typeof body.seq === 'number') return `seen(${body.seq})`;
  } catch {
    return 'other';
  }
  return 'other';
}

/** The one server the stand-in sockets of the current file connect to. */
export const server: { current: ScriptedServer } = { current: new ScriptedServer() };

/**
 * Starts a fresh server for the next case.
 * @returns The new server.
 * @throws {never} Never.
 */
export function resetServer(): ScriptedServer {
  server.current = new ScriptedServer();
  return server.current;
}

/** The browser `WebSocket` stand-in. */
export class ScriptedWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readyState = 0;
  binaryType = 'blob';
  protocol = '';
  extensions = '';
  bufferedAmount = 0;
  /** The server this connection reached. */
  readonly server: ScriptedServer;

  /**
   * Dials the current server; it opens on a later task.
   * @param url - The address.
   */
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    this.server = server.current;
    this.server.connect(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }, 0);
  }

  /**
   * The client sends a frame; the server records and handles it at once.
   * @param data - The frame.
   */
  send(data: unknown): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.server.receive(this, data);
  }

  /**
   * Closes the connection.
   * @param code - Close code.
   * @param reason - Close reason.
   */
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: true }));
  }

  /**
   * The server drops the connection the way a network failure does (code 1006, not clean).
   * @param code - Close code.
   */
  drop(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '', wasClean: false }));
  }

  /**
   * Delivers one server frame to the client.
   * @param bytes - The frame.
   */
  deliver(bytes: Uint8Array): void {
    if (this.readyState !== 1) return;
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

let saved: unknown = null;

/**
 * Replaces the global `WebSocket` with {@link ScriptedWebSocket}. Call it
 * from `vi.hoisted`, before `chunking-websocket.ts` is evaluated.
 * @throws {never} Never.
 */
export function installScriptedWebSocket(): void {
  saved = (globalThis as { WebSocket?: unknown }).WebSocket ?? null;
  (globalThis as { WebSocket?: unknown }).WebSocket = ScriptedWebSocket;
}

/**
 * Puts the global `WebSocket` back (the jsdom document outlives the file).
 * @throws {never} Never.
 */
export function uninstallScriptedWebSocket(): void {
  (globalThis as { WebSocket?: unknown }).WebSocket = saved ?? undefined;
}

/**
 * Waits on real timers until the provider's send window and the server's
 * answers have long passed (at least 50 ms, spec 23.0, with the default rounds).
 * @param rounds - How many rounds of 10 ms to wait.
 * @returns Resolves when idle.
 * @throws {never} Never.
 */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** What {@link recordProviderEvents} listens to. */
export interface EventSource {
  on: (event: string, listener: (data: unknown) => void) => void;
}

/** The events a provider emitted since {@link recordProviderEvents} (spec 26.0). */
export interface ProviderEvents {
  /** How many `synced` events. */
  synced: number;
  /** The `number` of each `unsyncedChanges` event, in order. */
  unsynced: number[];
}

/**
 * Records a provider's `synced` events and the counts its `unsyncedChanges` events carry.
 * @param provider - The provider.
 * @returns The record, updated as events arrive.
 * @throws {never} Never.
 */
export function recordProviderEvents(provider: EventSource): ProviderEvents {
  const events: ProviderEvents = { synced: 0, unsynced: [] };
  provider.on('synced', () => { events.synced += 1; });
  provider.on('unsyncedChanges', (data) => { events.unsynced.push((data as { number: number }).number); });
  return events;
}

/** What the `H7` preconditions read on a provider. */
export interface HandshakeProvider {
  readonly synced: boolean;
  readonly isAuthenticated: boolean;
  readonly authorizedScope: string | undefined;
  readonly configuration: { websocketProvider: { webSocket: { readyState: number } | null } };
}

/**
 * Waits for a provider's handshake and checks the `H7` preconditions: synced,
 * authenticated with the expected scope, the socket open, and (for a writable
 * canvas or document) a baseline local write followed by a `sync:confirm`.
 * @param name - Canonical document name.
 * @param doc - The document.
 * @param provider - Its provider.
 * @param options - What to expect.
 * @param options.scope - The authorized scope.
 * @param options.confirms - Whether the document's binding sends receipts (canvas and document).
 * @param options.rounds - The rounds of {@link settle} each wait takes.
 * @returns Resolves when the preconditions hold.
 * @throws {AssertionError} When one does not.
 */
export async function expectHandshake(
  name: string,
  doc: Y.Doc,
  provider: HandshakeProvider,
  options: { scope?: string; confirms?: boolean; rounds?: number } = {},
): Promise<void> {
  const scope = options.scope ?? 'read-write';
  for (let i = 0; i < 400 && !(provider.synced && provider.isAuthenticated); i += 1) await settle(options.rounds ?? 1);
  expect(provider.synced).toBe(true);
  expect(provider.isAuthenticated).toBe(true);
  expect(provider.authorizedScope).toBe(scope);
  expect(provider.configuration.websocketProvider.webSocket?.readyState).toBe(ScriptedWebSocket.OPEN);
  if (options.confirms === false) return;
  const mark = server.current.mark();
  doc.transact(() => { doc.getMap('h7').set('baseline', mark); });
  await settle(options.rounds);
  expect(server.current.kinds(name, mark)).toContain('confirm');
}
