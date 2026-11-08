// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The inbound filter as production wires it (inner#1790, design 4.4, v2
 * collab test spec section 9: F-07, F-08 and F-10 through the production
 * hooks; plus the chunked-message drop and the collab side of S-04/S-06).
 *
 * `Server` is replaced by a stand-in that records its configuration, so the
 * hooks under test are the ones `createCollabServer` really registers:
 * `receiveFrame` (reassembly, then the filter), `onPeerClose`, `onPeerError`,
 * `beforeSync` and `afterLoadDocument`. No second copy of the hook logic is
 * written here.
 */

import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModule from "@breatic/core";
import type * as ConfigModule from "@collab/config.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const { serverSpy, logs } = vi.hoisted(() => ({
  serverSpy: vi.fn(),
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@hocuspocus/extension-redis", () => ({ Redis: class {} }));

vi.mock("@hocuspocus/server", async (importOriginal) => ({
  ...(await importOriginal<typeof HocuspocusServerModule>()),
  Server: class {
    hocuspocus = { documents: new Map() };
    constructor(config: unknown) {
      serverSpy(config);
    }
  },
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => logs,
  createRedisClient: vi.fn(() => ({
    on: vi.fn(),
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 1),
  })),
  getRedis: vi.fn(() => ({ on: vi.fn() })),
  getCollabRedis: vi.fn(() => ({ on: vi.fn() })),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  getProjectConcurrentEditorLimit: vi.fn(async () => 100),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  accountActivityRepo: { recordActivity: vi.fn(async () => undefined) },
}));

// The scaled configuration of spec 0.2 (S config).
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  const { S_CONFIG } = await import("@collab/__tests__/helpers/document-size-fixtures.js");
  const scaled = Object.freeze({ ...real.getCollabConfig(), ...S_CONFIG });
  return { ...real, getCollabConfig: () => scaled };
});

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
}));

vi.mock("@collab/services/connection-registry.js", () => ({
  createConnectionRegistry: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    count: vi.fn(async () => 0),
  })),
}));

import { Document } from "@hocuspocus/server";
import {
  COLLAB_CHUNK_ACK,
  COLLAB_DOCUMENT_TOO_LARGE_REASON,
  COLLAB_FRAME_MAX_BYTES,
  DOC_SIZE_EVENT_BYTES,
  DocSizeStatusSchema,
} from "@breatic/shared";
import * as shared from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import { filter, markRefused } from "@collab/infra/inbound-filter.js";
import { recordExact } from "@collab/services/document-size.js";
import { S } from "@collab/__tests__/helpers/document-size-fixtures.js";
import { SYNC, WIRE, authFrame, awarenessFrame, syncFrame } from "@collab/__tests__/helpers/live-hocuspocus.js";

const D = "project-p1/canvas-s1";
const E = "project-p1/document-s2";

/** A crossws peer as the production hooks see it. */
interface FakePeer {
  remoteAddress: string;
  _hocuspocus: { socketId: string };
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

/** A crossws message. */
interface FakeMessage {
  rawData: Buffer | string;
  uint8Array: () => Uint8Array;
  text: () => string;
}

/** The production hooks this file drives. */
interface Hooks {
  receiveFrame: (peer: FakePeer, message: FakeMessage) => Uint8Array | undefined;
  onPeerClose: (peer: FakePeer, event: unknown) => void;
  onPeerError: (peer: FakePeer, error: unknown) => void;
  beforeSync: (payload: unknown) => Promise<void>;
  afterLoadDocument: (payload: unknown) => Promise<void>;
  onStateless: (payload: unknown) => Promise<void>;
}

let hooks: Hooks;

beforeAll(async () => {
  serverSpy.mockClear();
  await createCollabServer({
    collabRedisUrl: "redis://localhost:6379/3",
    port: 1234,
    redisKeyPrefix: "test",
    shutdownDeadline: () => undefined,
  });
  hooks = serverSpy.mock.calls[0]?.[0] as Hooks;
});

/**
 * A peer on its own socket.
 * @param socketId - The Hocuspocus socket id.
 * @returns The peer.
 */
function peer(socketId: string): FakePeer {
  return { remoteAddress: "10.0.0.1", _hocuspocus: { socketId }, close: vi.fn(), send: vi.fn() };
}

/**
 * A binary frame.
 * @param bytes - Payload.
 * @returns The message.
 */
function bin(bytes: Uint8Array): FakeMessage {
  return { rawData: Buffer.from(bytes), uint8Array: () => bytes, text: () => Buffer.from(bytes).toString() };
}

/**
 * A text frame.
 * @param s - Text.
 * @returns The message.
 */
function txt(s: string): FakeMessage {
  return { rawData: s, uint8Array: () => new TextEncoder().encode(s), text: () => s };
}

/**
 * Assert the production `receiveFrame` hands the frame on byte for byte.
 * @param p - The peer.
 * @param frame - The frame.
 * @param label - Names the frame in a failure.
 */
function passes(p: FakePeer, frame: Uint8Array, label: string): void {
  const out = hooks.receiveFrame(p, bin(frame));
  expect(out, label).toBeInstanceOf(Uint8Array);
  expect(Array.from(out as Uint8Array), label).toEqual(Array.from(frame));
}

/**
 * Assert the production `receiveFrame` drops the frame.
 * @param p - The peer.
 * @param frame - The frame.
 * @param label - Names the frame in a failure.
 */
function drops(p: FakePeer, frame: Uint8Array, label: string): void {
  expect(hooks.receiveFrame(p, bin(frame)), label).toBeUndefined();
}

/**
 * A real Yjs update.
 * @returns The update bytes.
 */
function realUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 7;
  doc.getText("t").insert(0, "hello");
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

const UPDATE = realUpdate();
const EMPTY_STEP2 = Uint8Array.of(0, 0);

const frames = {
  auth: (name: string): Uint8Array => authFrame(name, "__cookie_auth__"),
  step2: (name: string): Uint8Array => syncFrame(name, WIRE.sync, SYNC.step2, EMPTY_STEP2),
  update: (name: string, payload: Uint8Array = UPDATE): Uint8Array => syncFrame(name, WIRE.sync, SYNC.update, payload),
  awareness: (name: string): Uint8Array => awarenessFrame(name, Uint8Array.of(0)),
};

/**
 * Load `D` through the production load hook, bring its record to the limit
 * (`full`, spec G-06's situation), let the connection acknowledge that full
 * push, and run the production `beforeSync` on an insert from `socketId`,
 * which step 4 must refuse.
 * @param socketId - The connection's socket.
 * @returns Nothing.
 */
async function refuseThroughBeforeSync(socketId: string): Promise<void> {
  const document = new Document(D);
  await hooks.afterLoadDocument({
    documentName: D,
    document,
    instance: { documents: new Map([[D, document]]) },
    context: { user: { id: "u1" } },
  });
  const connection = {
    socketId,
    readOnly: false,
    context: { user: { id: "u1" } },
    sendStateless: vi.fn(),
    webSocket: { close: vi.fn(), send: vi.fn() },
    request: new Request("http://collab.test/?size_ack=1"),
  };
  // A refusal marks only a connection still in the document (design 4.2).
  document.addConnection(connection as never);
  recordExact(D, S.L);
  const [pushed] = connection.sendStateless.mock.calls.at(-1) as [string];
  const { seq } = JSON.parse(pushed) as { seq?: unknown };
  await hooks.onStateless({ connection, documentName: D, document, payload: JSON.stringify({ type: "doc:size-seen", seq }) });
  await expect(
    hooks.beforeSync({
      clientsCount: 1,
      context: connection.context,
      document,
      documentName: D,
      connection,
      type: SYNC.update,
      payload: UPDATE,
    }),
  ).rejects.toMatchObject({ reason: COLLAB_DOCUMENT_TOO_LARGE_REASON });
}

describe("the production inbound filter", () => {
  it("F-10 (filter side) drops what follows a beforeSync refusal until the next Auth", async () => {
    const p = peer("s127");
    passes(p, frames.auth(D), "auth");
    passes(p, frames.step2(D), "step2");
    passes(p, frames.update(D), "the update beforeSync will refuse");
    await refuseThroughBeforeSync("s127");

    drops(p, frames.update(D), "update after the refusal");
    drops(p, frames.step2(D), "step2 after the refusal");
    drops(p, frames.awareness(D), "awareness after the refusal");

    passes(p, frames.auth(D), "auth clears the refusal");
    passes(p, frames.step2(D), "step2 after the new auth");
    expect(p.close).not.toHaveBeenCalled();
  });

  it("F-07 (a) forgets a socket's marks when crossws reports it closed", () => {
    const refused = peer("s128a");
    passes(refused, frames.auth(D), "auth");
    passes(refused, frames.step2(D), "step2");
    markRefused("s128a", D);
    hooks.onPeerClose(refused, {});
    drops(refused, frames.update(D), "update with no record left (waiting)");
    passes(refused, frames.step2(D), "step2 once the refusal is gone");

    const handshaken = peer("s128a-h");
    passes(handshaken, frames.auth(D), "auth");
    passes(handshaken, frames.step2(D), "step2");
    hooks.onPeerClose(handshaken, {});
    drops(handshaken, frames.update(D), "update after close (handshake mark gone)");
  });

  it("F-07 (b) forgets a socket's marks when ws reports an error", () => {
    // The reassembler treats a peer that errored as closed and drops its
    // frames itself, so what is left of the filter's marks is read from the
    // filter directly.
    const refused = peer("s128b");
    passes(refused, frames.auth(D), "auth");
    passes(refused, frames.step2(D), "step2");
    markRefused("s128b", D);
    hooks.onPeerError(refused, new Error("x"));
    expect(filter(refused as never, frames.update(D)), "update with no record left (waiting)").toBeUndefined();
    const step2 = frames.step2(D);
    expect(Array.from(filter(refused as never, step2) ?? []), "step2 once the refusal is gone").toEqual(Array.from(step2));

    const handshaken = peer("s128b-h");
    passes(handshaken, frames.auth(D), "auth");
    passes(handshaken, frames.step2(D), "step2");
    hooks.onPeerError(handshaken, new Error("x"));
    expect(filter(handshaken as never, frames.update(D)), "update after error (handshake mark gone)").toBeUndefined();
  });

  it("drops a whole chunked message of a refused document without closing the socket", () => {
    const p = peer("s129");
    passes(p, frames.auth(E), "auth E");
    passes(p, frames.step2(E), "step2 E");
    passes(p, frames.auth(D), "auth D");
    passes(p, frames.step2(D), "step2 D");
    markRefused("s129", D);

    const total = 300_000;
    let filler = total - 64;
    let message = frames.update(D, new Uint8Array(filler));
    while (message.byteLength !== total) {
      filler += total - message.byteLength;
      message = frames.update(D, new Uint8Array(filler));
    }
    const chunks = [
      message.subarray(0, COLLAB_FRAME_MAX_BYTES),
      message.subarray(COLLAB_FRAME_MAX_BYTES, 2 * COLLAB_FRAME_MAX_BYTES),
      message.subarray(2 * COLLAB_FRAME_MAX_BYTES),
    ];

    expect(hooks.receiveFrame(p, txt(JSON.stringify({ type: "chunked", bytes: total })))).toBeUndefined();
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(p.send).toHaveBeenNthCalledWith(1, COLLAB_CHUNK_ACK);
    expect(hooks.receiveFrame(p, bin(chunks[0]!))).toBeUndefined();
    expect(p.send).toHaveBeenCalledTimes(2);
    expect(p.send).toHaveBeenNthCalledWith(2, COLLAB_CHUNK_ACK);
    expect(hooks.receiveFrame(p, bin(chunks[1]!))).toBeUndefined();
    expect(p.send).toHaveBeenCalledTimes(3);
    expect(p.send).toHaveBeenNthCalledWith(3, COLLAB_CHUNK_ACK);
    expect(hooks.receiveFrame(p, bin(chunks[2]!)), "the completed message is dropped whole").toBeUndefined();
    expect(p.send).toHaveBeenCalledTimes(3);
    expect(p.close).not.toHaveBeenCalled();

    passes(p, frames.update(E), "E update on the same socket");
  });

  it("F-08 refuses under the name before \\0, so another session key cannot slip past", async () => {
    const p = peer("s134");
    const sess1 = `${D}\0sess-1`;
    passes(p, frames.auth(sess1), "auth D\\0sess-1");
    passes(p, frames.step2(sess1), "step2 D\\0sess-1");
    passes(p, frames.update(sess1), "the update beforeSync will refuse");
    // Hocuspocus names the connection's document by the part before \0.
    await refuseThroughBeforeSync("s134");

    drops(p, frames.update(`${D}\0sess-9`), "update under another session key");
    drops(p, frames.step2(D), "step2 under the bare name");
    expect(p.close).not.toHaveBeenCalled();
  });
});

describe("the shared entry as collab reads it", () => {
  it("S-06 exposes the v2 size contract through @breatic/shared", () => {
    expect(COLLAB_DOCUMENT_TOO_LARGE_REASON).toBe("Document size limit reached");
    expect(DOC_SIZE_EVENT_BYTES).toBe(32);
    const push = { type: "doc:size", seq: 0, bytes: 0, limit: 10485760, ceiling: 10747904, phase: "normal" };
    const parsed = DocSizeStatusSchema.safeParse(push);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(push);
    const entry = shared as Record<string, unknown>;
    expect(entry.DocSizeSeenSchema).toBeDefined();
    expect(entry.DOC_SIZE_ACK_PARAM).toBe("size_ack");
  });
});
