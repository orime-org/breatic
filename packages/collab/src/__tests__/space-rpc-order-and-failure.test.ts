// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Step order and failure policy for the meta-doc write RPCs
 * (ADR 2026-08-02 space-rpc-step-order-and-failure-policy, §10.1 row 1).
 *
 * One rule generates every assertion in this file: **the broadcast is the
 * commit boundary**. The fixed order is
 *
 *   checks (all up front, read-only)
 *     -> content rows
 *       -> the meta entry, which IS the broadcast
 *         -> the activity row
 *           -> the reply
 *
 * Anything that must not be undone happens before the broadcast; anything
 * after it is allowed to fail with a log line, because a broadcast cannot
 * be taken back (§3.2 — `conn.transact` sends inside the synchronous
 * callback, so by the time the await rejects the update is already out).
 *
 * How order is observed without a real Hocuspocus: every step of interest
 * is a `vi.fn`, and vitest stamps a global monotonically increasing
 * `mock.invocationCallOrder` on every call to every mock, so calls to
 * DIFFERENT mocks are comparable. The broadcast itself is not a mock —
 * it is proxied by {@link metaBroadcastMock}, driven off the fake meta
 * doc's `update` event, which fires if and only if the doc really
 * changed. That distinction matters: a handler that opens a connection,
 * decides nothing needs changing and returns must show ZERO broadcasts,
 * and only a real doc-change signal can tell that apart from "transact
 * was called".
 *
 * Scope: this file is the logic layer, so the fake `transact` is fine —
 * it neither persists nor broadcasts for real. The things that need a
 * live server (a store failure AFTER the broadcast, frame-level
 * read-only enforcement) are §10.2 / §10.4 and live elsewhere.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";

const {
  softDeleteByNameMock,
  restoreByNameMock,
  seedInitialStateMock,
  countLiveSpaceDocsMock,
  withSpaceDeleteLockMock,
  FakeLockBusyError,
  activityInsertMock,
  activityInsertIgnoreMock,
  activityLatestUnrestoredMock,
  activityConsumeRestoreMock,
  loggerErrorMock,
  loggerWarnMock,
  loggerInfoMock,
  loggerDebugMock,
} = vi.hoisted(() => ({
  softDeleteByNameMock: vi.fn(),
  restoreByNameMock: vi.fn(),
  seedInitialStateMock: vi.fn(),
  countLiveSpaceDocsMock: vi.fn(),
  withSpaceDeleteLockMock: vi.fn(),
  FakeLockBusyError: class FakeLockBusyError extends Error {},
  activityInsertMock: vi.fn(),
  activityInsertIgnoreMock: vi.fn(),
  activityLatestUnrestoredMock: vi.fn(),
  activityConsumeRestoreMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

// The yjs-store repo moved to collab; space-rpc imports it locally. These
// four are the "content rows" of the design: the PG rows that hold the
// user's actual writing.
vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  softDeleteByName: softDeleteByNameMock,
  restoreByName: restoreByNameMock,
  seedInitialState: seedInitialStateMock,
  countLiveSpaceDocs: countLiveSpaceDocsMock,
}));

// The cross-instance delete lock has its own unit tests. Here it is a
// pass-through by default so the critical section is exercised directly;
// one test replaces it with a version that throws while releasing, which
// is the shape the real `finally { await redis.eval(...) }` has.
vi.mock("@collab/services/space-delete-lock.js", () => ({
  withSpaceDeleteLock: withSpaceDeleteLockMock,
  SpaceDeleteLockBusyError: FakeLockBusyError,
}));

// Spread the real core barrel (writeSpaceEntry / encodeInitialSpaceContentState
// keep the real impls the Yjs assertions depend on) and override the logger
// with STABLE mocks — several assertions below are about what a swallowed
// failure logs, which a fresh no-op stub per call cannot answer.
vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createLogger: () => ({
      info: loggerInfoMock,
      warn: loggerWarnMock,
      error: loggerErrorMock,
      debug: loggerDebugMock,
    }),
    projectActivitiesRepo: {
      insert: activityInsertMock,
      insertIgnoreDuplicateTask: activityInsertIgnoreMock,
      latestUnrestoredDeleted: activityLatestUnrestoredMock,
      consumeRestoreAndAppend: activityConsumeRestoreMock,
      listByProject: vi.fn(),
    },
  };
});

import { handleSpaceRpc } from "../services/space-rpc.js";
import {
  spaceContentDocName,
  projectMetaDocName,
  type DocKind,
} from "@breatic/shared";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
/** A second Space, so `SID` is never the last one and delete is allowed. */
const OTHER_SID = "33333333-3333-4333-8333-333333333333";
const ACTOR = "u-actor-1";
/** A well-formed uuid v4 standing in for the per-click claim token. */
const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** The content-doc kinds delete / restore act on, mirroring the handler. */
const CONTENT_KINDS: readonly Exclude<DocKind, "meta">[] = [
  "canvas",
  "document",
  "timeline",
];

/**
 * Wording only a database driver ever emits. The reply that reaches the
 * client is rendered straight into a toast (§6 preamble), so none of this
 * may survive into `error.message`.
 */
const DATABASE_WORDING = [
  "duplicate key value",
  "violates unique constraint",
  "yjs_documents",
  "ECONNREFUSED",
  "relation \"",
];

/**
 * A `space:deleted` activity row, the source restore rebuilds the entry
 * from. Same shape the repo returns.
 */
const DELETED_ROW = {
  id: "act-del-1",
  projectId: PID,
  actorUserId: "u-0",
  actorName: null,
  type: "space:deleted" as const,
  spaceId: SID,
  nodeId: null,
  taskId: null,
  payload: {
    spaceName: "Main",
    spaceSnapshot: {
      id: SID,
      type: "canvas",
      name: "Main",
      order: 0,
      locked: false,
      createdAt: 1780900000000,
      createdBy: "u-0",
    },
  },
  restored: false,
  createdAt: 1780900001000,
};

/**
 * Stand-in for the broadcast. Driven off the fake meta doc's `update`
 * event, so it fires once per transaction that really changed the doc and
 * never for one that decided to change nothing.
 */
const metaBroadcastMock = vi.fn();

let metaDoc: Y.Doc;
let disconnectMock: ReturnType<typeof vi.fn>;
let broadcastStatelessMock: ReturnType<typeof vi.fn>;

/**
 * How many times `transact` ran in the current test, across every direct
 * connection. A refused pre-check must leave this at zero: `transact`
 * always attempts a store, so a check that goes through it can be
 * defeated by a database problem that has nothing to do with the check.
 */
let transactCalls = 0;

/** Per-test overrides for the fake direct connection to the meta doc. */
interface MetaConnectionBehaviour {
  /**
   * Runs while the connection is being opened, i.e. before ANY read. Use it
   * for operations that read and write in a single transact, where "the doc
   * changed under us" and "it was already like that" are the same thing.
   */
  onOpen?: () => void;
  /**
   * Runs immediately before the FIRST `transact` — the window §4 says
   * every pre-check re-opens. Pre-checks read `conn.document` directly
   * and have already run by then, so this is where "the doc changed
   * under us" belongs for every handler whose checks live outside the
   * write, and the write's re-check is what has to catch it.
   */
  beforeFirstTransact?: () => void;
  /**
   * When set, every `transact` rejects AFTER running its callback — the
   * real library's shape (§3.2): the callback runs synchronously, the
   * broadcast leaves inside it, and only then does the awaited store fail.
   */
  storeFails?: boolean;
  /** Replaces the default `disconnect`, e.g. to make the finally throw. */
  disconnect?: () => Promise<void>;
}

/**
 * Build a Hocuspocus stub whose direct connection writes into {@link metaDoc}.
 * @param behaviour - Optional hooks for the open / disconnect steps.
 * @returns A Hocuspocus stand-in accepted by `SpaceRpcContext`.
 */
function makeHocuspocus(behaviour: MetaConnectionBehaviour = {}): Hocuspocus {
  return {
    openDirectConnection: vi.fn(async () => {
      behaviour.onOpen?.();
      let transacts = 0;
      return {
        // The real `DirectConnection` exposes the live Y.Doc as a public
        // field (`DirectConnection.d.ts`), and `Document extends Doc`
        // (`Document.d.ts:6`). Reading it is pure memory: no store hook,
        // so no way for a database problem to swallow a check's answer.
        document: metaDoc,
        transact: async (fn: (doc: Y.Doc) => void) => {
          transacts += 1;
          transactCalls += 1;
          if (transacts === 1) behaviour.beforeFirstTransact?.();
          fn(metaDoc);
          if (behaviour.storeFails) {
            throw new Error(
              'error persisting document: relation "yjs_documents" is unreachable',
            );
          }
        },
        disconnect: behaviour.disconnect ?? disconnectMock,
      };
    }),
    documents: new Map([
      [
        projectMetaDocName(PID),
        {
          broadcastStateless: (payload: string) =>
            broadcastStatelessMock(payload),
        },
      ],
    ]),
  } as unknown as Hocuspocus;
}

/**
 * Put a Space entry into the fake meta doc's `spaces` map.
 * @param id - The Space id, used as the map key and the entry's `id`.
 * @param fields - The rest of the entry's fields.
 */
function seedSpace(id: string, fields: Record<string, unknown>): void {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  for (const [k, v] of Object.entries(fields)) entry.set(k, v);
  metaDoc.getMap("spaces").set(id, entry);
}

/**
 * Forget every broadcast recorded so far, so the marker only reports the
 * ones the handler under test causes. Call it after any test setup that
 * mutates the doc — including a mutation staged inside `onOpen` to
 * simulate a concurrent change.
 */
function armBroadcastMarker(): void {
  metaBroadcastMock.mockClear();
}

/**
 * Read a mock's first invocation-order stamp — vitest's global counter,
 * which is what makes stamps from different mocks comparable.
 * @param mock - The mock to read.
 * @param label - Name used in the failure message when it never ran.
 * @returns The order stamp of the mock's first call.
 * @throws {Error} When the mock was never called.
 */
function firstCallOrder(
  mock: { mock: { invocationCallOrder: number[] } },
  label: string,
): number {
  const first = mock.mock.invocationCallOrder[0];
  if (first === undefined) {
    throw new Error(`expected ${label} to have been called, but it never was`);
  }
  return first;
}

/**
 * Every structured context object handed to `logger.error` / `logger.warn`,
 * in call order. Pino-style: the context object is the first argument.
 * @returns One record per logged line.
 */
function loggedContexts(): Record<string, unknown>[] {
  return [...loggerErrorMock.mock.calls, ...loggerWarnMock.mock.calls]
    .map((call) => call[0])
    .filter(
      (ctx): ctx is Record<string, unknown> =>
        typeof ctx === "object" && ctx !== null,
    );
}

/**
 * Whether some logged line names both the Space and the person who acted.
 * The key the actor is logged under is not pinned — the VALUE is, which is
 * what an on-call engineer actually needs at 3am.
 * @param spaceId - Space the log line must name.
 * @param actorUserId - Acting user the log line must name.
 * @returns True when one logged context carries both.
 */
function loggedSpaceAndActor(spaceId: string, actorUserId: string): boolean {
  return loggedContexts().some(
    (ctx) =>
      ctx["spaceId"] === spaceId && Object.values(ctx).includes(actorUserId),
  );
}

/**
 * Assert an error reply says something, and says nothing a database wrote.
 * @param message - The `error.message` handed back to the client.
 */
function expectNoDatabaseWording(message: string): void {
  expect(message.length).toBeGreaterThan(0);
  for (const fragment of DATABASE_WORDING) {
    expect(message).not.toContain(fragment);
  }
}

beforeEach(() => {
  metaDoc = new Y.Doc();
  metaBroadcastMock.mockReset();
  // The commit boundary: Yjs emits `update` only for a transaction that
  // really changed something.
  metaDoc.on("update", () => {
    metaBroadcastMock();
  });
  disconnectMock = vi.fn(async () => {});
  broadcastStatelessMock = vi.fn();
  transactCalls = 0;

  softDeleteByNameMock.mockReset();
  softDeleteByNameMock.mockResolvedValue(true);
  restoreByNameMock.mockReset();
  // Mirrors `softDeleteByName`: true means THIS call is the one that changed
  // the row, which is how a handler knows what it owes an undo for.
  restoreByNameMock.mockResolvedValue(true);
  seedInitialStateMock.mockReset();
  seedInitialStateMock.mockResolvedValue(true);
  countLiveSpaceDocsMock.mockReset();
  countLiveSpaceDocsMock.mockResolvedValue(2);
  withSpaceDeleteLockMock.mockReset();
  withSpaceDeleteLockMock.mockImplementation(
    async (_projectId: string, fn: () => Promise<unknown>) => fn(),
  );
  activityInsertMock.mockReset();
  activityInsertMock.mockResolvedValue("act-1");
  activityInsertIgnoreMock.mockReset();
  activityLatestUnrestoredMock.mockReset();
  activityLatestUnrestoredMock.mockResolvedValue(null);
  activityConsumeRestoreMock.mockReset();
  activityConsumeRestoreMock.mockResolvedValue(true);
  loggerErrorMock.mockReset();
  loggerWarnMock.mockReset();
  loggerInfoMock.mockReset();
  loggerDebugMock.mockReset();
});

describe("step order — content rows, then the broadcast, then the activity row", () => {
  it("space:create seeds the content row before the broadcast and writes the activity row after it", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );

    expect(res.ok).toBe(true);
    const contentRow = firstCallOrder(seedInitialStateMock, "seedInitialState");
    const broadcast = firstCallOrder(metaBroadcastMock, "the meta broadcast");
    const activityRow = firstCallOrder(activityInsertMock, "the activity row");
    expect(contentRow).toBeLessThan(broadcast);
    expect(broadcast).toBeLessThan(activityRow);
    // Exactly one broadcast: the entry goes in with one transaction.
    expect(metaBroadcastMock).toHaveBeenCalledTimes(1);
  });

  it("space:delete soft-deletes the content rows before the broadcast and writes the activity row after it", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, {
      type: "canvas",
      name: "Second",
      order: 1,
      locked: false,
    });
    armBroadcastMarker();

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    expect(res.ok).toBe(true);
    const contentRow = firstCallOrder(softDeleteByNameMock, "softDeleteByName");
    const broadcast = firstCallOrder(metaBroadcastMock, "the meta broadcast");
    const activityRow = firstCallOrder(activityInsertMock, "the activity row");
    expect(contentRow).toBeLessThan(broadcast);
    expect(broadcast).toBeLessThan(activityRow);
  });

  it("space:restore un-deletes the content rows before the broadcast and writes the activity row after it", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );

    expect(res.ok).toBe(true);
    const contentRow = firstCallOrder(restoreByNameMock, "restoreByName");
    const broadcast = firstCallOrder(metaBroadcastMock, "the meta broadcast");
    const activityRow = firstCallOrder(
      activityConsumeRestoreMock,
      "the activity row",
    );
    expect(contentRow).toBeLessThan(broadcast);
    expect(broadcast).toBeLessThan(activityRow);
  });

  it("space:lock broadcasts before it writes the activity row", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    armBroadcastMarker();

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:lock", payload: { spaceId: SID, locked: true } },
    );

    expect(res.ok).toBe(true);
    expect(
      firstCallOrder(metaBroadcastMock, "the meta broadcast"),
    ).toBeLessThan(firstCallOrder(activityInsertMock, "the activity row"));
    expect(metaBroadcastMock).toHaveBeenCalledTimes(1);
  });
});

describe("a content-row failure stops before the broadcast", () => {
  it("space:create broadcasts nothing and writes no activity row when seeding the content row fails", async () => {
    seedInitialStateMock.mockRejectedValue(new Error("write failed"));

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );

    // The step that had to fail really was attempted.
    expect(seedInitialStateMock).toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    expect(activityInsertMock).not.toHaveBeenCalled();
    expect(metaDoc.getMap("spaces").size).toBe(0);
  });

  it("space:delete broadcasts nothing, writes no activity row and leaves the entry alone when soft-deleting the content rows fails", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, {
      type: "canvas",
      name: "Second",
      order: 1,
      locked: false,
    });
    armBroadcastMarker();
    softDeleteByNameMock.mockRejectedValue(new Error("write failed"));

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    expect(softDeleteByNameMock).toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    expect(activityInsertMock).not.toHaveBeenCalled();
    // Nothing to roll back precisely because meta was never touched.
    expect(metaDoc.getMap("spaces").has(SID)).toBe(true);
  });

  it("space:create hands back a controlled error, never the database's own wording", async () => {
    seedInitialStateMock.mockRejectedValue(
      new Error(
        'duplicate key value violates unique constraint "yjs_documents_pkey"',
      ),
    );

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expectNoDatabaseWording(res.error.message);
  });
});

describe("re-reading the target fails — the content rows are rolled back", () => {
  it("space:delete restores the content rows it soft-deleted when the entry has vanished by the time it writes", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, {
      type: "canvas",
      name: "Second",
      order: 1,
      locked: false,
    });
    const hocuspocus = makeHocuspocus({
      beforeFirstTransact: () => {
        // A collaborator deleted it in the window the checks opened.
        metaDoc.getMap("spaces").delete(SID);
        armBroadcastMarker();
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    expect(activityInsertMock).not.toHaveBeenCalled();
    for (const kind of CONTENT_KINDS) {
      expect(restoreByNameMock).toHaveBeenCalledWith(
        spaceContentDocName(PID, SID, kind),
      );
    }
  });

  it("space:delete rolls back only the content rows this call actually soft-deleted", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, {
      type: "canvas",
      name: "Second",
      order: 1,
      locked: false,
    });
    // Only the canvas variant existed and was flipped; the other two were
    // already gone, so un-deleting them would resurrect somebody else's row.
    softDeleteByNameMock.mockImplementation(async (name: string) =>
      name === spaceContentDocName(PID, SID, "canvas"),
    );
    const hocuspocus = makeHocuspocus({
      beforeFirstTransact: () => {
        metaDoc.getMap("spaces").delete(SID);
        armBroadcastMarker();
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    expect(res.ok).toBe(false);
    expect(restoreByNameMock).toHaveBeenCalledTimes(1);
    expect(restoreByNameMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "canvas"),
    );
    expect(restoreByNameMock).not.toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "document"),
    );
    expect(restoreByNameMock).not.toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "timeline"),
    );
  });

  it("space:restore soft-deletes the content rows again when the Space is already back by the time it writes", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);
    const hocuspocus = makeHocuspocus({
      beforeFirstTransact: () => {
        // Another owner restored it in the window the checks opened.
        seedSpace(SID, {
          type: "canvas",
          name: "Main",
          order: 0,
          locked: false,
        });
        armBroadcastMarker();
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    expect(activityConsumeRestoreMock).not.toHaveBeenCalled();
    expect(softDeleteByNameMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "canvas"),
    );
  });
});

describe("the rollback itself fails", () => {
  it("space:delete still answers the original NOT_FOUND when the rollback throws, and logs what is left behind", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, {
      type: "canvas",
      name: "Second",
      order: 1,
      locked: false,
    });
    restoreByNameMock.mockRejectedValue(
      new Error("ECONNREFUSED connecting to yjs_documents host"),
    );
    const hocuspocus = makeHocuspocus({
      beforeFirstTransact: () => {
        metaDoc.getMap("spaces").delete(SID);
        armBroadcastMarker();
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    // The precondition: a rollback was genuinely attempted and threw. Without
    // this the rest of the test would also pass for an implementation that
    // never rolls back at all.
    expect(restoreByNameMock).toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Best-effort means best-effort: a failed rollback does not change the
    // answer the caller was already owed, and does not become an INTERNAL.
    expect(res.error.code).toBe("NOT_FOUND");
    expectNoDatabaseWording(res.error.message);
    expect(loggedSpaceAndActor(SID, ACTOR)).toBe(true);
  });
});

describe("the activity row is allowed to fail", () => {
  it("space:create still succeeds when the activity row fails", async () => {
    activityInsertMock.mockRejectedValue(new Error("activity write failed"));

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );

    expect(activityInsertMock).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    const newId = res.ok ? res.result?.spaceId : undefined;
    expect(typeof newId).toBe("string");
    expect(metaDoc.getMap("spaces").has(newId as string)).toBe(true);
  });

  it("space:create logs the spaceId and the actor when the activity row fails", async () => {
    activityInsertMock.mockRejectedValue(new Error("activity write failed"));

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );

    const newId = res.ok ? res.result?.spaceId : undefined;
    expect(typeof newId).toBe("string");
    expect(loggedSpaceAndActor(newId as string, ACTOR)).toBe(true);
  });

  it("space:delete still succeeds when the activity row fails", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, {
      type: "canvas",
      name: "Second",
      order: 1,
      locked: false,
    });
    activityInsertMock.mockRejectedValue(new Error("activity write failed"));

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    expect(activityInsertMock).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(metaDoc.getMap("spaces").has(SID)).toBe(false);
  });

  it("space:delete logs the spaceId, the actor and the lost snapshot when the activity row fails", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, {
      type: "canvas",
      name: "Second",
      order: 1,
      locked: false,
    });
    activityInsertMock.mockRejectedValue(new Error("activity write failed"));

    await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    expect(loggedSpaceAndActor(SID, ACTOR)).toBe(true);
    // The snapshot is the only way back for this Space and it just failed
    // to reach the ledger, so the log line has to carry it.
    const withSnapshot = loggedContexts().filter(
      (ctx) => ctx["spaceId"] === SID,
    );
    expect(JSON.stringify(withSnapshot)).toContain("Main");
  });
});

describe("finishing steps cannot change the answer already decided", () => {
  it("space:create keeps its success when disconnect throws", async () => {
    const hocuspocus = makeHocuspocus({
      disconnect: async () => {
        // A failed store poisons the document; disconnect then fails too
        // (2026-08-01 hocuspocus-transact-semantics probe).
        throw new Error("ECONNREFUSED storing document");
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );

    expect(res.ok).toBe(true);
    expect(res.ok ? typeof res.result?.spaceId : undefined).toBe("string");
    expect(metaBroadcastMock).toHaveBeenCalledTimes(1);
    expect(loggedContexts().some((ctx) => ctx["projectId"] === PID)).toBe(true);
  });

  it("space:lock keeps its NOT_FOUND when disconnect throws", async () => {
    const hocuspocus = makeHocuspocus({
      disconnect: async () => {
        throw new Error("ECONNREFUSED storing document");
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:lock", payload: { spaceId: SID, locked: true } },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");
    expectNoDatabaseWording(res.error.message);
  });

  // The release throwing lives in the LOCK, and so does the protection: the
  // real `withSpaceDeleteLock` swallows + logs a failing release
  // (space-delete-lock.test.ts pins that against the real module). A
  // mock-level re-enactment here would only ever test the mock.
});

describe("space:rename re-checks all three conditions at the moment it writes", () => {
  it("answers NOT_FOUND when the Space is deleted between the check and the write", async () => {
    seedSpace(SID, { type: "canvas", name: "Foo", order: 0, locked: false });
    const hocuspocus = makeHocuspocus({
      onOpen: () => {
        metaDoc.getMap("spaces").delete(SID);
        armBroadcastMarker();
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "Bar" } },
    );

    // The concurrent change really landed before the handler wrote.
    expect(metaDoc.getMap("spaces").has(SID)).toBe(false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");
    // Writing to a stale entry reference does not throw, it silently does
    // nothing AND still emits an update (2026-08-02 stale-precheck probe) —
    // so the absence of a broadcast is what proves the re-check ran.
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    expect(activityInsertMock).not.toHaveBeenCalled();
  });

  it("answers FORBIDDEN when the Space is locked between the check and the write", async () => {
    seedSpace(SID, { type: "canvas", name: "Foo", order: 0, locked: false });
    const hocuspocus = makeHocuspocus({
      onOpen: () => {
        const entry = metaDoc.getMap("spaces").get(SID) as Y.Map<unknown>;
        entry.set("locked", true);
        armBroadcastMarker();
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "Bar" } },
    );

    const entry = metaDoc.getMap("spaces").get(SID) as Y.Map<unknown>;
    // The concurrent lock really landed before the handler wrote.
    expect(entry.get("locked")).toBe(true);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("FORBIDDEN");
    expect(entry.get("name")).toBe("Foo");
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    expect(activityInsertMock).not.toHaveBeenCalled();
  });

  it("is an idempotent success writing no activity row and no broadcast when the Space already carries the new name", async () => {
    seedSpace(SID, { type: "canvas", name: "Foo", order: 0, locked: false });
    const hocuspocus = makeHocuspocus({
      onOpen: () => {
        // A concurrent rename got there first with the very same name.
        const entry = metaDoc.getMap("spaces").get(SID) as Y.Map<unknown>;
        entry.set("name", "Bar");
        armBroadcastMarker();
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "Bar" } },
    );

    expect(res.ok).toBe(true);
    expect(
      (metaDoc.getMap("spaces").get(SID) as Y.Map<unknown>).get("name"),
    ).toBe("Bar");
    // Re-setting a Y.Map key to the value it already holds still emits an
    // update, so a missing same-name guard would show up here as a second
    // broadcast and a phantom "renamed Bar to Bar" row.
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    expect(activityInsertMock).not.toHaveBeenCalled();
  });

  it("records the name the Space carried at the moment it wrote, not the one the check saw", async () => {
    seedSpace(SID, { type: "canvas", name: "Foo", order: 0, locked: false });
    const hocuspocus = makeHocuspocus({
      onOpen: () => {
        const entry = metaDoc.getMap("spaces").get(SID) as Y.Map<unknown>;
        entry.set("name", "Mid");
        armBroadcastMarker();
      },
    });

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "Bar" } },
    );

    expect(res.ok).toBe(true);
    expect(metaBroadcastMock).toHaveBeenCalledTimes(1);
    // "Foo" here would mean oldName was read during the check and went
    // stale — the feed would claim a rename that never happened (§6.5).
    expect(activityInsertMock).toHaveBeenCalledWith({
      projectId: PID,
      actorUserId: ACTOR,
      type: "space:renamed",
      spaceId: SID,
      payload: { spaceName: "Bar", oldSpaceName: "Mid" },
    });
  });
});

describe("a store failure after the broadcast — the four handlers without content rows", () => {
  // §6's preamble is a shared convention for all seven operations, not a
  // perk of the three that move content rows: once the callback has written,
  // every client has applied the change, so a store rejection afterwards is
  // logged and the caller is still told the truth — it happened.
  beforeEach(() => {
    seedSpace(SID, { type: "canvas", name: "Foo", order: 0, locked: false });
  });

  it("space:rename still answers success and writes its activity row", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "Bar" } },
    );
    expect(res.ok).toBe(true);
    const entry = metaDoc.getMap("spaces").get(SID) as Y.Map<unknown>;
    expect(entry.get("name")).toBe("Bar");
    expect(activityInsertMock).toHaveBeenCalledTimes(1);
  });

  it("space:lock still answers success and writes its activity row", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:lock", payload: { spaceId: SID, locked: true } },
    );
    expect(res.ok).toBe(true);
    const entry = metaDoc.getMap("spaces").get(SID) as Y.Map<unknown>;
    expect(entry.get("locked")).toBe(true);
    expect(activityInsertMock).toHaveBeenCalledTimes(1);
  });

  it("tab:open still answers success once the seed-or-insert has gone out", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "viewer" },
      { id: "r1", type: "tab:open", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
  });

  it("tab:close still answers success once the removal has gone out", async () => {
    const userMap = new Y.Map<unknown>();
    const list = new Y.Array<string>();
    metaDoc.getMap("perUser").set(ACTOR, userMap);
    userMap.set("openTabIds", list);
    list.push([SID, OTHER_SID]);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "viewer" },
      { id: "r1", type: "tab:close", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(list.toArray()).toEqual([OTHER_SID]);
  });

  it("space:delete answers success and keeps the rows deleted when the store fails after the broadcast", async () => {
    // Every check passed, so the removal went out to every client. §1: past
    // the boundary the answer is success and nothing is undone — putting
    // the content rows back would leave rows for a Space nobody can see.
    seedSpace(OTHER_SID, { type: "canvas", name: "B", order: 1, locked: false });
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(softDeleteByNameMock).toHaveBeenCalled();
    expect(restoreByNameMock).not.toHaveBeenCalled();
  });
});

describe("a partial content-row failure undoes exactly what succeeded", () => {
  // Promise.all discards every fulfilled result the moment one rejects —
  // the two UPDATEs that won are already committed, but the caller would
  // see an empty "touched" list and undo nothing. The report has to
  // survive the failure.
  it("space:delete puts back the kinds whose soft-delete won", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, { type: "canvas", name: "B", order: 1, locked: false });
    softDeleteByNameMock.mockImplementation(async (name: string) => {
      if (name.includes("/document-")) {
        throw new Error('relation "yjs_documents" is unreachable');
      }
      return true;
    });
    armBroadcastMarker();

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INTERNAL");
    expectNoDatabaseWording(res.error.message);
    // The entry never left; nothing was published.
    expect(metaDoc.getMap("spaces").has(SID)).toBe(true);
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    // The two variants that DID get soft-deleted come back — and only those.
    const undone = restoreByNameMock.mock.calls.map((c) => c[0] as string);
    expect(undone.sort()).toEqual(
      [
        spaceContentDocName(PID, SID, "canvas"),
        spaceContentDocName(PID, SID, "timeline"),
      ].sort(),
    );
  });

  it("space:restore re-deletes the kinds whose un-delete won", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);
    restoreByNameMock.mockImplementation(async (name: string) => {
      if (name.includes("/document-")) {
        throw new Error('relation "yjs_documents" is unreachable');
      }
      return true;
    });
    armBroadcastMarker();

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INTERNAL");
    expectNoDatabaseWording(res.error.message);
    expect(metaDoc.getMap("spaces").has(SID)).toBe(false);
    expect(metaBroadcastMock).not.toHaveBeenCalled();
    const undone = softDeleteByNameMock.mock.calls.map((c) => c[0] as string);
    expect(undone.sort()).toEqual(
      [
        spaceContentDocName(PID, SID, "canvas"),
        spaceContentDocName(PID, SID, "timeline"),
      ].sort(),
    );
  });
});

describe("one operation, one broadcast", () => {
  // §6.2 step 5: removing the entry and sweeping everyone's tabs happen
  // "in the same broadcast". Yjs only merges writes that share a
  // transaction — without doc.transact around the callback, every list
  // touched is its own update frame, and a client can observe the entry
  // gone while some tabs still point at it.
  it("space:delete removes the entry and sweeps every tab list in a single update", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, { type: "canvas", name: "B", order: 1, locked: false });
    for (const user of ["u-1", "u-2"]) {
      const userMap = new Y.Map<unknown>();
      const list = new Y.Array<string>();
      metaDoc.getMap("perUser").set(user, userMap);
      userMap.set("openTabIds", list);
      list.push([SID, OTHER_SID]);
    }
    armBroadcastMarker();

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );

    expect(res.ok).toBe(true);
    expect(metaBroadcastMock).toHaveBeenCalledTimes(1);
    // The one update really carried BOTH halves — a delete that removed the
    // entry but skipped the sweep (or vice versa) would also count one.
    expect(metaDoc.getMap("spaces").has(SID)).toBe(false);
    for (const user of ["u-1", "u-2"]) {
      const userMap = metaDoc.getMap<Y.Map<unknown>>("perUser").get(user);
      const list = userMap?.get("openTabIds") as Y.Array<string>;
      expect(list.toArray()).toEqual([OTHER_SID]);
    }
  });
});

describe("opening the meta connection fails — nothing has been done yet", () => {
  // The connection open used to sit BETWEEN seeding the content row and the
  // try that owns every undo path: an open failure orphaned the seeded row,
  // and the ghost inflated the authoritative Space count the delete floor
  // reads. Opening first removes the window instead of compensating for it.
  it("space:create has not seeded anything when openDirectConnection rejects", async () => {
    const hocuspocus = {
      openDirectConnection: vi.fn(async () => {
        throw new Error('relation "yjs_documents" is unreachable');
      }),
      documents: new Map(),
    } as unknown as Hocuspocus;

    const res = await handleSpaceRpc(
      { hocuspocus },
      PID,
      { userId: ACTOR, role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expectNoDatabaseWording(res.error.message);
    // The load-bearing half: no content row exists for an id nobody
    // will ever see, so the delete floor's count stays truthful.
    expect(seedInitialStateMock).not.toHaveBeenCalled();
  });
});

describe("a guard's answer outranks a store failure it did not cause", () => {
  // When the callback wrote nothing because a guard fired, the guard READ
  // the world and its answer is true regardless of what the store did
  // afterwards. create / delete / restore already answer the semantic code;
  // these pin the same precedence for the handlers that used to answer
  // INTERNAL while knowing better.
  it("space:lock answers NOT_FOUND, not INTERNAL, when the Space is gone and the store fails", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:lock", payload: { spaceId: SID, locked: true } },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");
  });

  it("space:rename answers NOT_FOUND when the Space is gone and the store fails", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "X" } },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");
  });

  it("space:rename answers FORBIDDEN when the Space is locked and the store fails", async () => {
    seedSpace(SID, { type: "canvas", name: "Foo", order: 0, locked: true });
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "X" } },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("FORBIDDEN");
  });

  it("space:rename to the same name stays an idempotent success when the store fails (§6.5)", async () => {
    seedSpace(SID, { type: "canvas", name: "Foo", order: 0, locked: false });
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "Foo" } },
    );
    expect(res.ok).toBe(true);
    expect(activityInsertMock).not.toHaveBeenCalled();
  });

  it("tab:open answers NOT_FOUND when the Space does not exist and the store fails", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "viewer" },
      { id: "r1", type: "tab:open", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");
  });
});

/**
 * Give `userId` an explicit tab list, i.e. the "has a record, has a list"
 * state. Needed to reach `tab:close`'s nothing-to-remove branch: with no
 * record at all the seed runs first and puts every Space in the list, so
 * there would always be something to remove.
 * @param userId - Whose tab bar to seed.
 * @param ids - The Space ids the list starts with.
 */
function seedTabList(userId: string, ids: readonly string[]): void {
  const userMap = new Y.Map<unknown>();
  const list = new Y.Array<string>();
  metaDoc.getMap("perUser").set(userId, userMap);
  userMap.set("openTabIds", list);
  list.push([...ids]);
}

describe("a refused pre-check is a pure read — a broken store cannot reach it", () => {
  // The library's `transact` runs the callback and then stores the doc
  // unconditionally (`hocuspocus-server.esm.js:2097-2112`), so a check that
  // goes through it hands back two answers: what it saw, and whether the
  // database is healthy. Those are unrelated, and every handler had to
  // hand-write which one wins. Reading `conn.document` directly removes the
  // second answer, so there is nothing left to order. See §6 opening.
  beforeEach(() => {
    seedSpace(SID, { type: "canvas", name: "Main", order: 0, locked: false });
    seedSpace(OTHER_SID, {
      type: "canvas",
      name: "Second",
      order: 1,
      locked: false,
    });
  });

  it("space:delete still says NOT_FOUND for a Space that is gone, with the store failing", async () => {
    metaDoc.getMap("spaces").delete(SID);
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Telling the user to retry sends them after something that can never
    // succeed: the Space really is gone, and it will still be gone after
    // the database recovers.
    expect(res.error.code).toBe("NOT_FOUND");
  });

  it("space:delete still says CONFLICT for the last Space, with the store failing", async () => {
    countLiveSpaceDocsMock.mockResolvedValue(1);
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");
  });

  it("space:restore still says CONFLICT for a Space that is already back, with the store failing", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");
  });

  it("tab:close stays an idempotent success for a tab that was not open, with the store failing", async () => {
    seedTabList(ACTOR, [OTHER_SID]);
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus({ storeFails: true }) },
      PID,
      { userId: ACTOR, role: "viewer" },
      { id: "r1", type: "tab:close", payload: { spaceId: SID } },
    );
    // §6.6: closing a tab that is not open is a success. Nothing needed
    // writing, so nothing about the store can change that answer.
    expect(res.ok).toBe(true);
  });

  it("space:delete's refusal costs zero transacts", async () => {
    metaDoc.getMap("spaces").delete(SID);
    await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    // Pins HOW, not just what: re-ordering two branches would satisfy the
    // assertions above while leaving the check inside `transact`, where the
    // next handler added can be defeated the same way.
    expect(transactCalls).toBe(0);
  });

  it("space:restore's refusal costs zero transacts", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);
    await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(transactCalls).toBe(0);
  });

  it("tab:close costs zero transacts when there is nothing to close", async () => {
    seedTabList(ACTOR, [OTHER_SID]);
    await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: ACTOR, role: "viewer" },
      { id: "r1", type: "tab:close", payload: { spaceId: SID } },
    );
    expect(transactCalls).toBe(0);
  });

  it("tab:close stays a success when another machine closes it in the write window and the store fails", async () => {
    seedTabList(ACTOR, [SID, OTHER_SID]);
    const res = await handleSpaceRpc(
      {
        hocuspocus: makeHocuspocus({
          storeFails: true,
          beforeFirstTransact: () => {
            // The same account on a second machine got there first.
            const userMap = metaDoc
              .getMap<Y.Map<unknown>>("perUser")
              .get(ACTOR);
            const list = userMap?.get("openTabIds") as Y.Array<string>;
            list.delete(list.toArray().indexOf(SID), 1);
          },
        }),
      },
      PID,
      { userId: ACTOR, role: "viewer" },
      { id: "r1", type: "tab:close", payload: { spaceId: SID } },
    );
    // The re-check inside the write decided there was nothing to write.
    // That verdict READ the world, so it outranks the store failure — the
    // same shape §6.5 already gives rename's same-name case.
    expect(res.ok).toBe(true);
  });
});
