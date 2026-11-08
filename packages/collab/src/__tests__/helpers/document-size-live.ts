// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Live-instance helpers for the document size cap integration suites
 * (inner#1790, second version, v2 collab test spec section 13).
 *
 * The client is a raw WebSocket speaking the frames `@hocuspocus/provider`
 * speaks: the provider is a web dependency collab does not declare, so this
 * plays its part frame by frame: Auth, SyncStep1, answering the server's
 * SyncStep1 with a SyncStep2 (which is what sets the inbound filter's
 * handshake mark), Updates for local edits, and `sync:confirm`. Every server
 * frame is decoded and kept, CLOSE frames with their reason, so a case can
 * assert "refused with the size reason" or "never refused".
 *
 * One `SizeSocket` carries any number of document keys, as one browser tab
 * does; `openDoc` on the same socket after a refusal is the new Auth a
 * rebuilt provider sends (design 4.4).
 *
 * The rest are the instance chores every suite repeats: start and stop a
 * production instance, seed and read back the stored row, add project
 * members, and read the refusal log lines.
 */

import { randomBytes, randomUUID } from "node:crypto";
import * as core from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON, spaceContentDocName } from "@breatic/shared";
import type { createCollabServer } from "@collab/hocuspocus.js";
import type * as SizeModuleShape from "@collab/services/document-size.js";
import { storeDocumentNow } from "@collab/services/persistence.js";
import { armTimedStore, releaseTimedStoreArm } from "@collab/services/store-tracker.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import * as decoding from "lib0/decoding";
import { expect } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import type { ActivityCollabFixture } from "./account-activity-fixture.js";
import { authFrame, statelessFrame, SYNC, syncFrame, waitFor, WIRE } from "./live-hocuspocus.js";

/** One decoded server → client frame. */
export interface SizeFrame {
  /** The whole message key. */
  key: string;
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
 * Decode one frame, sent by the server or by a client.
 * @param bytes - The frame.
 * @returns The decoded frame.
 */
export function decodeFrame(bytes: Uint8Array): SizeFrame {
  const decoder = decoding.createDecoder(bytes);
  const key = decoding.readVarString(decoder);
  const nul = key.indexOf("\0");
  const frame: SizeFrame = { key, documentName: nul === -1 ? key : key.slice(0, nul), type: decoding.readVarUint(decoder) };
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
  /** Whether the server closed the socket (a close this side did not start). */
  closedByServer(): boolean;
  /** The `seq` of every `doc:size-seen` this socket sent, oldest first, with the message key. */
  acks: Array<{ key: string; seq: unknown }>;
  /** Every frame this socket sent, oldest first. */
  sent: Uint8Array[];
  /** Per message key: send the document's buffered updates now (design 5.6; set by `openDoc`). */
  flushers: Map<string, () => void>;
}

/** How a socket speaks the size cap's acknowledgement (design 3, 5.1). */
export interface SizeAckOptions {
  /** Whether the socket URL carries `size_ack=1` (default true: the current web client). */
  sizeAck?: boolean;
  /** Whether each `doc:size` is answered with `doc:size-seen` in the same callback (default: as `sizeAck`). */
  autoAck?: boolean;
  /** Runs in that callback when a `doc:size` arrives, before the buffered updates are flushed and the acknowledgement sent. */
  beforeAck?: (key: string, push: Record<string, unknown>) => void;
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
  /** Send `doc:size-seen` for a push `seq`, after the buffered updates. */
  ack(seq: unknown): void;
  /** Send the updates `edit` buffered (`flushDelayMs`), as `HocuspocusProvider.flushPendingUpdates` does. */
  flushPendingUpdates(): void;
}

/**
 * Send `doc:size-seen` for a push on a socket and remember it.
 * @param socket - The socket.
 * @param key - The document's message key.
 * @param seq - The push's `seq`.
 */
function sendAck(socket: SizeSocket, key: string, seq: unknown): void {
  // Design 5.6: a stateless message goes after the updates written before it.
  socket.flushers.get(key)?.();
  socket.acks.push({ key, seq });
  socket.send(statelessFrame(key, JSON.stringify({ type: "doc:size-seen", seq })));
}

/**
 * Open a WebSocket carrying the fixture's session cookie.
 * @param port - The instance's port.
 * @param cookie - Session cookie header value.
 * @param opts - How the socket acknowledges size pushes; by default as the current web client does.
 * @returns The socket.
 * @throws {Error} When the socket cannot open.
 */
export async function openSocket(port: number, cookie: string, opts: SizeAckOptions = {}): Promise<SizeSocket> {
  const sizeAck = opts.sizeAck ?? true;
  const autoAck = opts.autoAck ?? sizeAck;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${sizeAck ? "?size_ack=1" : ""}`, { headers: { cookie } });
  let closedHere = false;
  let closed = false;
  const socket: SizeSocket = {
    ws,
    frames: [],
    acks: [],
    sent: [],
    flushers: new Map(),
    send: (bytes: Uint8Array): void => {
      socket.sent.push(bytes);
      ws.send(bytes);
    },
    close: (): void => {
      closedHere = true;
      ws.terminate();
    },
    closedByServer: (): boolean => closed && !closedHere,
  };
  ws.on("error", () => {});
  ws.on("close", () => {
    closed = true;
  });
  ws.on("message", (data) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (typeof bytes === "string") return;
    const frame = decodeFrame(new Uint8Array(bytes));
    socket.frames.push(frame);
    if (!autoAck || frame.stateless === undefined) return;
    const message = JSON.parse(frame.stateless) as Record<string, unknown>;
    if (message.type !== "doc:size") return;
    opts.beforeAck?.(frame.key, message);
    sendAck(socket, frame.key, message.seq);
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
 * @param opts.flushDelayMs - Buffer `edit` updates this long before sending, as a provider with `flushDelay` does (default: send at once).
 * @returns The opened document.
 * @throws {Error} When authentication does not complete.
 */
export async function openDoc(
  socket: SizeSocket,
  documentName: string,
  opts: { key?: string; doc?: Y.Doc; mode?: "read-write" | "readonly"; answerServerStep1?: boolean; flushDelayMs?: number } = {},
): Promise<SizeDocClient> {
  const key = opts.key ?? documentName;
  const doc = opts.doc ?? new Y.Doc();
  let pending: Uint8Array | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Send the buffered updates as one Update.
   */
  const flushPendingUpdates = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!pending) return;
    const update = pending;
    pending = undefined;
    socket.send(syncFrame(key, WIRE.sync, SYNC.update, update));
  };
  socket.flushers.set(key, flushPendingUpdates);
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
      if (opts.flushDelayMs !== undefined && outerType === WIRE.sync) {
        pending = pending ? Y.mergeUpdates([pending, update]) : update;
        flushTimer ??= setTimeout(flushPendingUpdates, opts.flushDelayMs);
        return update;
      }
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
    ack: (seq: unknown): void => sendAck(socket, key, seq),
    flushPendingUpdates,
  };
  return client;
}

/** A running production instance. */
export type Instance = Awaited<ReturnType<typeof createCollabServer>>;

/**
 * Start a production instance listening on loopback.
 * @param create - The `createCollabServer` to use (a fresh module graph has its own).
 * @param redisUrl - The collab Redis URL.
 * @param redisKeyPrefix - Key prefix; instances sharing one see each other's updates.
 * @returns The instance.
 */
export async function startInstance(create: typeof createCollabServer, redisUrl: string, redisKeyPrefix: string = `document-size-${randomUUID()}`): Promise<Instance> {
  const instance = await create({ port: 0, collabRedisUrl: redisUrl, redisKeyPrefix, shutdownDeadline: () => undefined });
  await instance.server.listen();
  return instance;
}

/**
 * Stop an instance the way shutdown does.
 * @param instance - The instance.
 */
export async function stopInstance(instance: Instance): Promise<void> {
  instance.stopUpgradeSessions();
  instance.storeLoop.stop();
  await instance.seatHandover.stop();
  await instance.server.destroy();
}

/**
 * Store content as the document's row before anyone opens it.
 * @param name - Document name.
 * @param src - Content.
 */
export async function seed(name: string, src: Y.Doc): Promise<void> {
  await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(src));
}

/**
 * Store the instance's copy now and read the row back.
 * @param instance - The instance holding the document.
 * @param name - Document name.
 * @returns A document built from the stored bytes.
 * @throws {Error} When no row is stored.
 */
export async function persisted(instance: Instance, name: string): Promise<Y.Doc> {
  // Persistence writes only a store the timed loop or the unload gate armed.
  const arm = armTimedStore(name);
  try {
    await storeDocumentNow(instance.hocuspocus, name);
  } finally {
    releaseTimedStoreArm(name, arm);
  }
  const data = await yjsRepo.fetchDocData(name);
  if (!data) throw new Error(`no stored row for ${name}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, data);
  return doc;
}

/**
 * The canvas document of a fixture (spec `CV`).
 * @param fixture - The fixture.
 * @returns Its name.
 */
export function canvasOf(fixture: ActivityCollabFixture): string {
  return spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
}

/**
 * The document-Space document of a fixture (spec `DOC`).
 * @param fixture - The fixture.
 * @returns Its name.
 */
export function documentOf(fixture: ActivityCollabFixture): string {
  return spaceContentDocName(fixture.projectId, fixture.spaceIds.document, "document");
}

/**
 * Add another member of the fixture's Project, with a session of its own.
 * @param fixture - The owner's fixture.
 * @param role - Project role.
 * @returns The member's fixture.
 */
export async function member(fixture: ActivityCollabFixture, role: "editor" | "viewer"): Promise<ActivityCollabFixture> {
  const [user] = await core.rawPg<{ id: string }[]>`INSERT INTO users(email,email_verified) VALUES(${`size-${role}-${randomUUID()}@example.test`},true) RETURNING id`;
  await core.rawPg`INSERT INTO studio_members(studio_id,user_id,role) SELECT studio_id,${user!.id},'guest' FROM projects WHERE id=${fixture.projectId}`;
  await core.rawPg`INSERT INTO project_members(project_id,user_id,role) VALUES(${fixture.projectId},${user!.id},${role})`;
  const token = randomBytes(24).toString("hex");
  await core.setSession(core.getRedis(), token, user!.id);
  return { ...fixture, userId: user!.id, cookie: `${core.sessionCookieName()}=${token}` };
}

/** One captured `warn` / `error` logger call. */
export interface LogLine {
  /** Logger method. */
  level: "warn" | "error";
  /** Its arguments. */
  args: unknown[];
}

/**
 * The fields of the refusal log lines (`document_size_limit_refused`) for a document.
 * @param logs - Captured lines.
 * @param name - Document name.
 * @returns The first argument of each line, oldest first.
 */
export function refusalsOf(logs: readonly LogLine[], name: string): Array<Record<string, unknown>> {
  return logs
    .filter((l) => l.level === "warn" && l.args[1] === "document_size_limit_refused")
    .map((l) => l.args[0] as Record<string, unknown>)
    .filter((f) => f.documentName === name);
}

/**
 * Wait for a client's document connection to be closed for size.
 * @param client - The client.
 * @param timeoutMs - How long to wait.
 */
export async function refusedFor(client: SizeDocClient, timeoutMs = 10_000): Promise<void> {
  await waitFor(() => client.closeReasons().includes(COLLAB_DOCUMENT_TOO_LARGE_REASON), `size refusal of ${client.key}`, timeoutMs);
}

/** The keys of a v2 `doc:size` push (design 3), sorted. */
export const V2_PUSH_KEYS: readonly string[] = ["bytes", "ceiling", "limit", "phase", "seq", "type"];

/**
 * The keys of a push, sorted, for comparing against {@link V2_PUSH_KEYS}.
 * @param push - A parsed `doc:size` message.
 * @returns Its keys.
 */
export function pushKeys(push: Record<string, unknown>): string[] {
  return Object.keys(push).sort();
}

/**
 * Wait until a client has received a `doc:size` push matching `predicate`
 * at or after index `from` of its pushes.
 * @param client - The client.
 * @param predicate - Condition on one push.
 * @param label - Shown on timeout.
 * @param from - Index into `sizePushes()` to start from.
 * @param timeoutMs - How long to wait (spec Q16: 5 s for the design's 2 s).
 * @returns The first matching push.
 */
export async function pushWhere(
  client: SizeDocClient,
  predicate: (push: Record<string, unknown>) => boolean,
  label: string,
  from = 0,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await waitFor(() => {
    found = client.sizePushes().slice(from).find(predicate);
    return found !== undefined;
  }, `${label} (${client.key})`, timeoutMs);
  return found!;
}

/**
 * Ask for `sync:confirmed` and wait for it or for a CLOSE of the document,
 * whichever comes first, so a case expecting admission fails on the close
 * reason rather than on a confirmation timeout.
 * @param client - The client.
 * @param timeoutMs - How long to wait.
 * @returns The CLOSE reasons received since the document was opened.
 */
export async function settle(client: SizeDocClient, timeoutMs = 10_000): Promise<string[]> {
  const id = randomUUID();
  client.socket.send(statelessFrame(client.key, JSON.stringify({ type: "sync:confirm", id })));
  await waitFor(() => client.closeReasons().length > 0 || client.frames().some((f) => f.stateless !== undefined && f.stateless.includes(id)), `confirmation or close of ${client.key}`, timeoutMs);
  return client.closeReasons();
}

/** The size module of one module graph, as a case reads `knowsFull` from it. */
type SizeModule = typeof SizeModuleShape;

/**
 * Whether the instance's record says a user's connection of a document has
 * acknowledged a `full` push (design 4.1 `knowsFull`), read through the
 * production export. Throws while the export is missing, so a case waiting
 * on it fails with that reason.
 * @param instance - The instance holding the document.
 * @param sizeModule - The size module of the instance's module graph.
 * @param name - Document name.
 * @param userId - Whose connection; the case's users each hold one.
 * @returns The production answer.
 * @throws {Error} When `knowsFull` is not exported, or the user has no connection of the document there.
 */
export function serverKnowsFull(instance: Instance, sizeModule: SizeModule, name: string, userId: string): boolean {
  const knowsFull = (sizeModule as unknown as Record<string, unknown>).knowsFull;
  if (typeof knowsFull !== "function") throw new Error("document-size.ts exports no knowsFull");
  const connection = instance.hocuspocus.documents.get(name)?.getConnections()
    .find((c) => (c.context as { user?: { id?: string } } | undefined)?.user?.id === userId);
  if (!connection) throw new Error(`${userId} has no connection of ${name}`);
  return (knowsFull as (n: string, c: unknown) => boolean)(name, connection) === true;
}

/**
 * Wait until the instance says a user's connection knows the document is full.
 * @param instance - The instance holding the document.
 * @param sizeModule - The size module of the instance's module graph.
 * @param name - Document name.
 * @param userId - Whose connection.
 * @param timeoutMs - How long to wait.
 * @throws {Error} When `knowsFull` is missing or never turns true.
 */
export async function untilKnowsFull(instance: Instance, sizeModule: SizeModule, name: string, userId: string, timeoutMs = 10_000): Promise<void> {
  expect(typeof (sizeModule as unknown as Record<string, unknown>).knowsFull, "document-size.ts exports knowsFull").toBe("function");
  await waitFor(() => serverKnowsFull(instance, sizeModule, name, userId), `knowsFull(${name}, ${userId})`, timeoutMs);
}
