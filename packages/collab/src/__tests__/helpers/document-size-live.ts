// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A raw WebSocket client for the document size cap integration suites
 * (inner#1790), speaking the frames `@hocuspocus/provider` speaks.
 *
 * The provider itself is a web dependency and is not declared by collab, so
 * this client plays its part frame by frame: Auth, SyncStep1, answering the
 * server's SyncStep1 with a SyncStep2 (which is what sets the inbound filter's
 * handshake mark), Updates for local edits, and `sync:confirm`. Every server
 * frame is decoded and kept, CLOSE frames with their reason, so a case can
 * assert "refused with the size reason" or "never refused".
 *
 * One `SizeSocket` carries any number of document keys, as one browser tab
 * does; `open` on the same socket after a refusal is the reset of design 5.3.
 */

import { randomUUID } from "node:crypto";
import * as decoding from "lib0/decoding";
import WebSocket from "ws";
import * as Y from "yjs";

import { authFrame, statelessFrame, SYNC, syncFrame, waitFor, WIRE } from "./live-hocuspocus.js";

/** One decoded server → client frame. */
export interface SizeFrame {
  /** Document name, the part of the key before the first NUL. */
  documentName: string;
  /** Outer type. */
  type: number;
  /** Sync sub-type for sync frames. */
  syncSubType?: number;
  /** Sync payload (state vector for SyncStep1, update otherwise). */
  payload?: Uint8Array;
  /** Stateless payload. */
  stateless?: string;
  /** Auth sub-type. */
  authSubType?: number;
  /** Auth scope or denial reason. */
  authDetail?: string;
  /** CLOSE reason. */
  closeReason?: string;
}

/**
 * Decode one server frame.
 * @param bytes - The frame.
 * @returns The decoded frame.
 */
function decodeFrame(bytes: Uint8Array): SizeFrame {
  const decoder = decoding.createDecoder(bytes);
  const key = decoding.readVarString(decoder);
  const nul = key.indexOf("\0");
  const frame: SizeFrame = { documentName: nul === -1 ? key : key.slice(0, nul), type: decoding.readVarUint(decoder) };
  if (frame.type === WIRE.sync || frame.type === WIRE.syncReply) {
    frame.syncSubType = decoding.readVarUint(decoder);
    frame.payload = decoding.readVarUint8Array(decoder);
  } else if (frame.type === WIRE.stateless) {
    frame.stateless = decoding.readVarString(decoder);
  } else if (frame.type === WIRE.auth) {
    frame.authSubType = decoding.readVarUint(decoder);
    if (frame.authSubType !== 0) frame.authDetail = decoding.readVarString(decoder);
  } else if (frame.type === WIRE.close) {
    frame.closeReason = decoding.readVarString(decoder);
  }
  return frame;
}

/** A WebSocket to a collab instance, shared by every document opened on it. */
export interface SizeSocket {
  /** The socket. */
  ws: WebSocket;
  /** Every server frame so far. */
  frames: SizeFrame[];
  /** Send raw bytes. */
  send(bytes: Uint8Array): void;
  /** Terminate the socket. */
  close(): void;
}

/** One document opened on a socket. */
export interface SizeDocClient {
  /** The socket it rides. */
  socket: SizeSocket;
  /** Document name. */
  documentName: string;
  /** The message key (document name, or name + NUL + session). */
  key: string;
  /** The client's copy. */
  doc: Y.Doc;
  /** Index of the first frame that belongs to this opening. */
  since: number;
  /** Frames for this document since it was opened. */
  frames(): SizeFrame[];
  /** CLOSE reasons received for this document since it was opened. */
  closeReasons(): string[];
  /** `doc:size` pushes received since it was opened, parsed. */
  sizePushes(): Array<Record<string, unknown>>;
  /** Send SyncStep1 and answer the server's SyncStep1; resolves once both directions are synced. */
  sync(): Promise<void>;
  /** Run an edit on the client copy and send its update. */
  edit(fn: (doc: Y.Doc) => void, outerType?: number): Uint8Array;
  /** Send a raw sync frame for this key. */
  sendSync(subType: number, payload: Uint8Array, outerType?: number): void;
  /** Ask for `sync:confirmed` and wait for it. */
  confirm(): Promise<Record<string, unknown>>;
}

/**
 * Open a WebSocket carrying the fixture's session cookie.
 * @param port - The instance's port.
 * @param cookie - Session cookie header value.
 * @returns The socket.
 * @throws {Error} When the socket cannot open.
 */
export async function openSocket(port: number, cookie: string): Promise<SizeSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });
  const socket: SizeSocket = {
    ws,
    frames: [],
    send: (bytes: Uint8Array): void => ws.send(bytes),
    close: (): void => ws.terminate(),
  };
  ws.on("error", () => {});
  ws.on("message", (data) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (typeof bytes === "string") return;
    socket.frames.push(decodeFrame(new Uint8Array(bytes)));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return socket;
}

/**
 * Open a document on a socket: Auth, wait for the server's answer.
 * @param socket - The socket.
 * @param documentName - Document name.
 * @param opts - Options.
 * @param opts.key - Message key when it differs from the name (NUL suffix).
 * @param opts.doc - The client copy to use (a fresh one by default).
 * @param opts.mode - The authorization the fixture expects.
 * @param opts.answerServerStep1 - Whether to answer the server's SyncStep1 automatically.
 * @returns The opened document.
 * @throws {Error} When authentication does not complete.
 */
export async function openDoc(
  socket: SizeSocket,
  documentName: string,
  opts: { key?: string; doc?: Y.Doc; mode?: "read-write" | "readonly"; answerServerStep1?: boolean } = {},
): Promise<SizeDocClient> {
  const key = opts.key ?? documentName;
  const doc = opts.doc ?? new Y.Doc();
  const since = socket.frames.length;
  let applied = since;
  let answered = false;
  /**
   * Frames for this document since it was opened.
   * @returns Frames.
   */
  const frames = (): SizeFrame[] => socket.frames.slice(since).filter((f) => f.documentName === documentName);
  /**
   * Apply server updates and answer the server's SyncStep1, as the provider does.
   */
  const pump = (): void => {
    for (; applied < socket.frames.length; applied++) {
      const f = socket.frames[applied]!;
      if (f.documentName !== documentName || (f.type !== WIRE.sync && f.type !== WIRE.syncReply) || !f.payload) continue;
      if (f.syncSubType === SYNC.step1) {
        if (opts.answerServerStep1 !== false && !answered) {
          answered = true;
          socket.send(syncFrame(key, WIRE.sync, SYNC.step2, Y.encodeStateAsUpdate(doc, f.payload)));
        }
      } else {
        Y.applyUpdate(doc, f.payload, "server");
      }
    }
  };
  socket.ws.on("message", () => pump());
  socket.send(authFrame(key, "__cookie_auth__"));
  const mode = opts.mode ?? "read-write";
  await waitFor(() => frames().some((f) => f.type === WIRE.auth && f.authSubType === 2 && f.authDetail === mode), `auth for ${key}`, 10_000);
  const client: SizeDocClient = {
    socket,
    documentName,
    key,
    doc,
    since,
    frames,
    closeReasons: (): string[] => frames().filter((f) => f.type === WIRE.close).map((f) => f.closeReason ?? ""),
    sizePushes: (): Array<Record<string, unknown>> =>
      frames()
        .filter((f) => f.stateless !== undefined)
        .map((f) => JSON.parse(f.stateless!) as Record<string, unknown>)
        .filter((m) => m.type === "doc:size"),
    sync: async (): Promise<void> => {
      socket.send(syncFrame(key, WIRE.sync, SYNC.step1, Y.encodeStateVector(doc)));
      await waitFor(() => {
        pump();
        return answered && frames().some((f) => f.type === WIRE.sync && f.syncSubType === SYNC.step2);
      }, `sync of ${key}`, 30_000);
    },
    edit: (fn: (d: Y.Doc) => void, outerType: number = WIRE.sync): Uint8Array => {
      let update: Uint8Array | undefined;
      const listener = (u: Uint8Array, origin: unknown): void => {
        if (origin !== "server") update = update ? Y.mergeUpdates([update, u]) : u;
      };
      doc.on("update", listener);
      doc.transact(() => fn(doc));
      doc.off("update", listener);
      if (!update) throw new Error("the edit emitted no update");
      socket.send(syncFrame(key, outerType, SYNC.update, update));
      return update;
    },
    sendSync: (subType: number, payload: Uint8Array, outerType: number = WIRE.sync): void => {
      socket.send(syncFrame(key, outerType, subType, payload));
    },
    confirm: async (): Promise<Record<string, unknown>> => {
      const id = randomUUID();
      socket.send(statelessFrame(key, JSON.stringify({ type: "sync:confirm", id })));
      let reply: Record<string, unknown> | undefined;
      await waitFor(() => {
        for (const f of frames()) {
          if (f.stateless === undefined) continue;
          const m = JSON.parse(f.stateless) as Record<string, unknown>;
          if (m.type === "sync:confirmed" && m.id === id) reply = m;
        }
        return reply !== undefined;
      }, `sync:confirmed for ${key}`, 30_000);
      return reply!;
    },
  };
  return client;
}
