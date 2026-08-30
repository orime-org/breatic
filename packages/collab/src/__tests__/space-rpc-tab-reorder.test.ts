// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `tab:reorder` — moving one tab inside the caller's own tab bar.
 *
 * The request is relative (which tab, which one it lands in front of) so a
 * tab the caller has never seen keeps its place, and the reply says whether
 * the server actually changed anything so an optimistic client knows
 * whether a broadcast is coming.
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
}));

vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  softDeleteByName: softDeleteByNameMock,
  restoreByName: restoreByNameMock,
  seedInitialState: seedInitialStateMock,
  countLiveSpaceDocs: countLiveSpaceDocsMock,
}));

vi.mock("@collab/services/space-delete-lock.js", () => ({
  withSpaceDeleteLock: withSpaceDeleteLockMock,
  SpaceDeleteLockBusyError: FakeLockBusyError,
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
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

const PID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-1111-4111-8111-000000000001";
const B = "bbbbbbbb-1111-4111-8111-000000000002";
const C = "cccccccc-1111-4111-8111-000000000003";
const ACTOR = "user-1";
const OTHER = "user-2";

let metaDoc: Y.Doc;

function makeHocuspocus(): Hocuspocus {
  return {
    openDirectConnection: vi.fn(async () => ({
      document: metaDoc,
      transact: async (fn: (doc: Y.Doc) => void) => {
        fn(metaDoc);
      },
      disconnect: vi.fn(async () => {}),
    })),
    documents: new Map(),
  } as unknown as Hocuspocus;
}

/**
 * Put a Space in the meta doc's `spaces` map.
 * @param id - The Space's id.
 * @param createdAt - Epoch millis, or undefined to leave the field off.
 * @returns Nothing.
 */
function seedSpace(id: string, createdAt?: number): void {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("type", "canvas");
  entry.set("name", id);
  if (createdAt !== undefined) entry.set("createdAt", createdAt);
  metaDoc.getMap("spaces").set(id, entry);
}

/**
 * Give a user an open-tab list holding exactly these ids.
 * @param userId - Whose list.
 * @param ids - What it holds, in order.
 * @returns The list, so a test can read it back.
 */
function seedTabs(userId: string, ids: string[]): Y.Array<string> {
  const userMap = new Y.Map<unknown>();
  const list = new Y.Array<string>();
  metaDoc.getMap("perUser").set(userId, userMap);
  userMap.set("openTabIds", list);
  list.push(ids);
  return list;
}

/**
 * Read a user's open-tab list out of the meta doc.
 * @param userId - Whose list.
 * @returns Its contents, or null when the user has no list.
 */
function readTabs(userId: string): string[] | null {
  const userMap = metaDoc
    .getMap<Y.Map<unknown>>("perUser")
    .get(userId);
  const list = userMap?.get("openTabIds");
  return list instanceof Y.Array ? (list.toArray() as string[]) : null;
}

/**
 * Send one `tab:reorder` as the given caller.
 * @param spaceId - The tab being moved.
 * @param beforeSpaceId - The tab it lands in front of, null for the end.
 * @param opts - Caller overrides.
 * @returns The RPC response.
 */
async function reorder(
  spaceId: string,
  beforeSpaceId: string | null,
  opts: { userId?: string; role?: "owner" | "editor" | "viewer" } = {},
): ReturnType<typeof handleSpaceRpc> {
  return handleSpaceRpc(
    { hocuspocus: makeHocuspocus() },
    PID,
    { userId: opts.userId ?? ACTOR, role: opts.role ?? "editor" },
    {
      id: "r1",
      type: "tab:reorder",
      payload: { spaceId, beforeSpaceId },
    },
  );
}

beforeEach(() => {
  metaDoc = new Y.Doc();
  softDeleteByNameMock.mockReset();
  restoreByNameMock.mockReset();
  seedInitialStateMock.mockReset();
  countLiveSpaceDocsMock.mockReset();
  countLiveSpaceDocsMock.mockResolvedValue(3);
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
});

describe("tab:reorder — moving a tab", () => {
  beforeEach(() => {
    seedSpace(A, 100);
    seedSpace(B, 200);
    seedSpace(C, 300);
  });

  it("puts the moved tab in front of the anchor", async () => {
    seedTabs(ACTOR, [A, B, C]);
    const res = await reorder(C, A);
    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([C, A, B]);
  });

  it("moves a tab forwards, past the anchor it used to sit in front of", async () => {
    seedTabs(ACTOR, [A, B, C]);
    const res = await reorder(A, C);
    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([B, A, C]);
  });

  it("moves a tab to the end when there is no anchor", async () => {
    seedTabs(ACTOR, [A, B, C]);
    const res = await reorder(A, null);
    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([B, C, A]);
  });

  it("says the order changed", async () => {
    seedTabs(ACTOR, [A, B, C]);
    const res = await reorder(C, A);
    expect(res.ok && res.result).toEqual({ orderChanged: true });
  });

  it("leaves a tab where it already is and says nothing changed", async () => {
    // Dropping a tab back where it started. The client already skips this,
    // but a request that arrives after another connection got there first
    // reaches the server looking exactly like it.
    seedTabs(ACTOR, [A, B, C]);
    const res = await reorder(A, B);
    expect(res.ok && res.result).toEqual({ orderChanged: false });
    expect(readTabs(ACTOR)).toEqual([A, B, C]);
  });

  it("treats a move onto itself as a success that changes nothing", async () => {
    seedTabs(ACTOR, [A, B, C]);
    const res = await reorder(A, A);
    expect(res.ok && res.result).toEqual({ orderChanged: false });
    expect(readTabs(ACTOR)).toEqual([A, B, C]);
  });
});

describe("tab:reorder — what it refuses", () => {
  beforeEach(() => {
    seedSpace(A, 100);
    seedSpace(B, 200);
    seedSpace(C, 300);
  });

  it("answers NOT_FOUND when the moved tab is not in the caller's list", async () => {
    seedTabs(ACTOR, [A, B]);
    const res = await reorder(C, A);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(readTabs(ACTOR)).toEqual([A, B]);
  });

  it("answers NOT_FOUND when the anchor is not in the caller's list", async () => {
    seedTabs(ACTOR, [A, B]);
    const res = await reorder(A, C);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(readTabs(ACTOR)).toEqual([A, B]);
  });
});

describe("tab:reorder — a list holding the same id twice", () => {
  beforeEach(() => {
    seedSpace(A, 100);
    seedSpace(B, 200);
    seedSpace(C, 300);
  });

  it("collapses a duplicate of the tab being moved into the copy it lands as", async () => {
    // Two collab instances that had not synced each moved A, so the merged
    // list holds it twice. The move takes every copy of A out and puts one
    // back, so this case is closed by the move itself.
    seedTabs(ACTOR, [A, B, C, A]);
    const res = await reorder(A, null);
    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([B, C, A]);
  });

  it("leaves a duplicate of some other tab where it is", async () => {
    // Only the browser's read-side dedupe hides this one, and a later close
    // sweeps every copy. Moving C says nothing about B, so B keeps both.
    seedTabs(ACTOR, [A, B, C, B]);
    const res = await reorder(C, A);
    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([C, A, B, B]);
  });

  it("reports a change when collapsing the copies was the only thing it did", async () => {
    // A is already in front of B, so its place does not change — but the
    // list loses the second copy of A, and a client waiting on a broadcast
    // has to be told one is coming.
    seedTabs(ACTOR, [A, B, C, A]);
    const res = await reorder(A, B);
    expect(res.ok && res.result).toEqual({ orderChanged: true });
    expect(readTabs(ACTOR)).toEqual([A, B, C]);
  });
});

describe("tab:reorder — the caller has no list yet", () => {
  it("seeds the list in createdAt order before it moves anything", async () => {
    // Written into the spaces map newest-first, so Y.Map iteration order
    // would give [C, A, B] and createdAt order gives [A, B, C]. Moving A to
    // the end tells the two apart: [C, B, A] against [B, C, A].
    seedSpace(C, 300);
    seedSpace(A, 100);
    seedSpace(B, 200);
    const res = await reorder(A, null);
    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([B, C, A]);
  });

  it("reports a change when seeding was the only thing it did", async () => {
    // The seed is a write, so a broadcast is coming even though the move
    // itself landed the tab where the seed had already put it.
    seedSpace(A, 100);
    seedSpace(B, 200);
    const res = await reorder(A, B);
    expect(res.ok && res.result).toEqual({ orderChanged: true });
    expect(readTabs(ACTOR)).toEqual([A, B]);
  });

  it("still leaves a seeded list behind when the guard then refuses", async () => {
    // Seeding is a write and has to happen before the guard can ask whether
    // the tab is in the list, so a refused reorder still leaves the caller
    // with the list they were always going to get.
    seedSpace(A, 100);
    seedSpace(B, 200);
    const res = await reorder("not-a-space", null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(readTabs(ACTOR)).toEqual([A, B]);
  });
});

describe("tab:reorder — whose bar it touches", () => {
  beforeEach(() => {
    seedSpace(A, 100);
    seedSpace(B, 200);
    seedSpace(C, 300);
  });

  it("leaves another user's list untouched", async () => {
    seedTabs(ACTOR, [A, B, C]);
    seedTabs(OTHER, [A, B, C]);
    await reorder(C, A);
    expect(readTabs(ACTOR)).toEqual([C, A, B]);
    expect(readTabs(OTHER)).toEqual([A, B, C]);
  });

  it("lets a viewer reorder their own bar", async () => {
    seedTabs(ACTOR, [A, B, C]);
    const res = await reorder(C, A, { role: "viewer" });
    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([C, A, B]);
  });
});

describe("tab:reorder — a tab the caller never saw", () => {
  it("keeps a concurrently opened tab in the list", async () => {
    // The client computed this move from the three tabs it could see. By
    // the time the request lands, another connection on the same account
    // has opened a fourth. A relative move does not mention it, so it stays.
    seedSpace(A, 100);
    seedSpace(B, 200);
    seedSpace(C, 300);
    const fourth = "dddddddd-1111-4111-8111-000000000004";
    seedSpace(fourth, 400);
    seedTabs(ACTOR, [A, B, C, fourth]);

    const res = await reorder(C, A);
    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([C, A, B, fourth]);
  });
});

describe("tab:reorder — a second collab instance holding the same document", () => {
  beforeEach(() => {
    seedSpace(A, 100);
    seedSpace(B, 200);
    seedSpace(C, 300);
  });

  it("leaves a tab the other instance closed closed", async () => {
    // Production runs more than one collab instance (space-delete-lock exists
    // for exactly that). A move that rewrites the whole array makes every id a
    // fresh insert, which the other replica's delete cannot reach — so a tab
    // closed there comes back, in the document, on both connections.
    seedTabs(ACTOR, [A, B, C]);
    const snapshot = Y.encodeStateAsUpdate(metaDoc);
    const other = new Y.Doc();
    Y.applyUpdate(other, snapshot);

    const beforeOther = Y.encodeStateVector(other);
    const otherUser = other
      .getMap<Y.Map<unknown>>("perUser")
      .get(ACTOR) as Y.Map<unknown>;
    const otherList = otherUser.get("openTabIds") as Y.Array<string>;
    otherList.delete(otherList.toArray().indexOf(B), 1);
    const otherUpdate = Y.encodeStateAsUpdate(other, beforeOther);

    const beforeThis = Y.encodeStateVector(metaDoc);
    await reorder(C, A);
    const thisUpdate = Y.encodeStateAsUpdate(metaDoc, beforeThis);

    Y.applyUpdate(metaDoc, otherUpdate);
    Y.applyUpdate(other, thisUpdate);

    expect(readTabs(ACTOR)).toEqual([C, A]);
  });
});
