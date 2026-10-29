// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One pong, two facts — and what the seat half answers.
 *
 * Both facts already have their own tests, and both of those pass when the
 * pong never reaches them — they call the functions directly. What is asserted
 * here is the wiring, which is what actually went missing: presence spent a
 * whole change unconnected to the pong while its expiry was cut to two ping
 * periods, and every test in the package stayed green.
 *
 * Since inner#1034 a renewal can also answer back, and the handler acts on
 * it: `replaced` asks for the other connection to be demoted, while
 * `full` (an arrival retried on this pong found no seat) and `lost` (a held
 * seat was gone and the document full) demote this socket's connection on
 * that document.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { OutgoingMessage } from "@hocuspocus/server";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("@breatic/core", () => ({
  env: { ENV: "test" },
  createLogger: () => ({ warn: logWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { readPresence } from "@collab/hooks/presence.js";
import { createPongHandler } from "@collab/services/socket-liveness.js";

type Deps = Parameters<typeof createPongHandler>[0];
type Connections = Parameters<ReturnType<typeof createPongHandler>>[1];
type SeatAnswer = Awaited<ReturnType<Deps["refreshSeats"]>>[number];

const PID = "11111111-1111-4111-8111-111111111111";
const META_DOC = `project-${PID}/meta`;
const ALICE = "u-alice";

/**
 * A meta document holding one online record.
 * @param lastSeenAt - When that record was last refreshed.
 * @returns The document.
 */
function metaDocWith(lastSeenAt: number): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    doc.getMap("users").set(ALICE, entry);
    entry.set("id", ALICE);
    entry.set("online", true);
    entry.set("lastSeenAt", lastSeenAt);
  });
  return doc;
}

/** A seat renewal that has nothing to report. */
const nothingToReport = (): ReturnType<Deps["refreshSeats"]> => Promise.resolve([]);

describe("a pong refreshes everything it proves", () => {
  it("moves the socket's seats forward", () => {
    const refreshSeats = vi.fn(nothingToReport);
    const handler = createPongHandler({
      refreshSeats,
      requestDemote: vi.fn(async () => undefined),
      presencePolicy: { now: () => 1_000, staleAfterMs: 60_000 },
    });

    handler("sock-1", new Map());

    expect(refreshSeats).toHaveBeenCalledWith("sock-1");
  });

  it("moves the owner of the socket's meta connection forward", () => {
    const doc = metaDocWith(1_000);
    const handler = createPongHandler({
      refreshSeats: vi.fn(nothingToReport),
      requestDemote: vi.fn(async () => undefined),
      presencePolicy: { now: () => 31_000, staleAfterMs: 60_000 },
    });

    handler(
      "sock-1",
      new Map<string, unknown>([
        [META_DOC, { context: { user: { id: ALICE } }, document: doc }],
      ]) as Connections,
    );

    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(31_000);
    doc.destroy();
  });

  it("does both from one pong, not one or the other", () => {
    // The two are independent calls, so a change that keeps one can drop the
    // other and leave both of their own suites green. This is the only case
    // that reads them together.
    const refreshSeats = vi.fn(nothingToReport);
    const doc = metaDocWith(1_000);
    const handler = createPongHandler({
      refreshSeats,
      requestDemote: vi.fn(async () => undefined),
      presencePolicy: { now: () => 31_000, staleAfterMs: 60_000 },
    });

    handler(
      "sock-1",
      new Map<string, unknown>([
        [META_DOC, { context: { user: { id: ALICE } }, document: doc }],
      ]) as Connections,
    );

    expect(refreshSeats).toHaveBeenCalledTimes(1);
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(31_000);
    doc.destroy();
  });
});

const D1 = `project-${PID}/canvas-22222222-2222-4222-9222-222222222222`;
const D2 = `project-${PID}/document-33333333-3333-4333-9333-333333333333`;
const D3 = `project-${PID}/canvas-44444444-4444-4444-9444-444444444444`;
const M = "u-alice:5000:i1:sock-1";
const X = "u-alice:1000:i2:sock-old";

/** A content-document connection whose sends are recorded. */
interface FakeConn {
  readOnly: boolean;
  document: Y.Doc;
  context: { user: { id: string } };
  webSocket: { send: ReturnType<typeof vi.fn> };
}

/**
 * A writable content-document connection.
 * @returns The connection.
 */
function contentConn(): FakeConn {
  return { readOnly: false, document: new Y.Doc(), context: { user: { id: ALICE } }, webSocket: { send: vi.fn() } };
}

/**
 * The frame telling a client its connection on `documentName` is read-only.
 * @param documentName - The document.
 * @returns The frame bytes.
 */
function readOnlyFrame(documentName: string): Uint8Array {
  return new OutgoingMessage(documentName).writeAuthenticated(true).toUint8Array();
}

/**
 * Whether a warn carrying this tag was logged with these fields.
 * @param tag - The log tag.
 * @param fields - Fields it must carry.
 * @returns True when one was.
 */
function warnedWith(tag: string, fields: Record<string, unknown> = {}): boolean {
  return logWarn.mock.calls.some(([logged, message]) => {
    if (typeof logged !== "object" || logged === null) return false;
    const o = logged as Record<string, unknown>;
    const tagged = message === tag || o.tag === tag || o.reason === tag;
    return tagged && Object.entries(fields).every(([k, v]) => o[k] === v);
  });
}

/**
 * Fire one pong whose seat renewal answers `answers`, and let it land.
 * @param answers - What the renewal reports.
 * @param connections - What the socket carries.
 * @returns The demote spy and the presence document, if any.
 */
async function pongWith(
  answers: SeatAnswer[],
  connections: Map<string, unknown>,
): Promise<{ requestDemote: ReturnType<typeof vi.fn> }> {
  const requestDemote = vi.fn(async () => undefined);
  const handler = createPongHandler({
    refreshSeats: vi.fn(async () => answers),
    requestDemote,
    presencePolicy: { now: () => 31_000, staleAfterMs: 60_000 },
  });
  expect(() => handler("sock-1", connections as Connections)).not.toThrow();
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { requestDemote };
}

describe("a pong acts on what the seat renewal answers (inner#1034)", () => {
  beforeEach(() => {
    logWarn.mockClear();
  });

  it("E-P01 asks for the replaced connection to be demoted, and demotes nothing here", async () => {
    const c1 = contentConn();
    const { requestDemote } = await pongWith(
      [{ documentName: D1, member: M, outcome: "replaced", replaced: X }],
      new Map([[D1, c1]]),
    );
    expect(requestDemote).toHaveBeenCalledTimes(1);
    expect(requestDemote).toHaveBeenCalledWith(D1, X);
    expect(c1.readOnly).toBe(false);
    expect(c1.webSocket.send).not.toHaveBeenCalled();
  });

  it("E-P02 demotes the connection whose retried arrival found the document full, and only that one", async () => {
    const c1 = contentConn();
    const c2 = contentConn();
    const { requestDemote } = await pongWith(
      [{ documentName: D1, member: M, outcome: "full", liveCount: 2, cap: 2 }],
      new Map([[D1, c1], [D2, c2]]),
    );
    expect(c1.readOnly).toBe(true);
    expect(c1.webSocket.send).toHaveBeenCalledTimes(1);
    expect(c1.webSocket.send.mock.calls[0]![0]).toEqual(readOnlyFrame(D1));
    expect(logWarn).toHaveBeenCalledWith(
      { socketId: "sock-1", userId: ALICE, documentName: D1, projectId: PID, liveCount: 2, cap: 2, reason: "connection_cap_race_degraded" },
      "connection_cap_race_degraded",
    );
    expect(c2.readOnly).toBe(false);
    expect(c2.webSocket.send).not.toHaveBeenCalled();
    expect(requestDemote).not.toHaveBeenCalled();
  });

  it("E-P03 demotes the connection that lost its seat and says so in the log", async () => {
    const c1 = contentConn();
    await pongWith([{ documentName: D1, member: M, outcome: "lost", liveCount: 3, cap: 3 }], new Map([[D1, c1]]));
    expect(c1.readOnly).toBe(true);
    expect(c1.webSocket.send).toHaveBeenCalledTimes(1);
    expect(c1.webSocket.send.mock.calls[0]![0]).toEqual(readOnlyFrame(D1));
    expect(logWarn).toHaveBeenCalledWith(
      { socketId: "sock-1", userId: ALICE, documentName: D1, projectId: PID, liveCount: 3, cap: 3, reason: "connection_seat_lost" },
      "connection_seat_lost",
    );
  });

  it("E-P04 handles each answer on its own document and still refreshes presence", async () => {
    const c1 = contentConn();
    const c2 = contentConn();
    const c3 = contentConn();
    const meta = metaDocWith(1_000);
    const { requestDemote } = await pongWith(
      [
        { documentName: D1, member: M, outcome: "replaced", replaced: X },
        { documentName: D2, member: "u-alice:5000:i1:sock-1", outcome: "full", liveCount: 2, cap: 2 },
        { documentName: D3, member: "u-alice:5000:i1:sock-1", outcome: "lost", liveCount: 2, cap: 2 },
      ],
      new Map<string, unknown>([
        [META_DOC, { context: { user: { id: ALICE } }, document: meta }],
        [D1, c1],
        [D2, c2],
        [D3, c3],
      ]),
    );
    expect(requestDemote).toHaveBeenCalledExactlyOnceWith(D1, X);
    expect(c1.readOnly).toBe(false);
    expect(c2.readOnly).toBe(true);
    expect(c2.webSocket.send).toHaveBeenCalledExactlyOnceWith(readOnlyFrame(D2));
    expect(c3.readOnly).toBe(true);
    expect(c3.webSocket.send).toHaveBeenCalledExactlyOnceWith(readOnlyFrame(D3));
    expect(warnedWith("connection_cap_race_degraded", { documentName: D2 })).toBe(true);
    expect(warnedWith("connection_seat_lost", { documentName: D3 })).toBe(true);
    expect(readPresence(meta, ALICE)?.lastSeenAt).toBe(31_000);
    meta.destroy();
  });

  it("E-P05 does nothing more when the renewal has nothing to report", async () => {
    const c1 = contentConn();
    const { requestDemote } = await pongWith([], new Map([[D1, c1]]));
    expect(requestDemote).not.toHaveBeenCalled();
    expect(c1.readOnly).toBe(false);
    expect(c1.webSocket.send).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("E-P06 skips an answer for a document this socket no longer carries", async () => {
    const c2 = contentConn();
    await pongWith([{ documentName: D1, member: M, outcome: "full", liveCount: 2, cap: 2 }], new Map([[D2, c2]]));
    expect(c2.readOnly).toBe(false);
    expect(c2.webSocket.send).not.toHaveBeenCalled();
  });
});
