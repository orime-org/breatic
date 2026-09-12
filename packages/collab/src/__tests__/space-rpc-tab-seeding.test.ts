// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Seeding a tab list, and the one thing that can empty it without the owner
 * asking.
 *
 * A member who has never touched their tab bar starts with ONE Space open —
 * the newest — so opening a project stops connecting a document per Space.
 * Every path that seeds a list goes through the same rule, because the two
 * replicas that produce a starting order (collab writing it, the browser
 * showing it until that write arrives) have to land on the same answer.
 *
 * The rule change makes a state reachable that the old one could not:
 * seeding used to put every Space in the list, so somebody else deleting one
 * left the rest. Seeding one means somebody else deleting THAT one leaves a
 * list that is empty — and an empty list is a real list, so the reader does
 * not fall back to a default and the tab bar stays blank for good. The
 * delete handler puts the newest remaining Space back, and it does that
 * itself rather than inside the sweep: the sweep cannot tell "this delete
 * emptied it" from "it was already empty", and restore reuses the same sweep
 * to make sure a restored Space does NOT come back as a tab.
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

import {
  handleSpaceRpc,
  seedOpenTabListOnFirstVisit,
} from "../services/space-rpc.js";

const PID = "11111111-1111-4111-8111-111111111111";
const OLDEST = "aaaaaaaa-1111-4111-8111-000000000001";
const MIDDLE = "bbbbbbbb-1111-4111-8111-000000000002";
const NEWEST = "cccccccc-1111-4111-8111-000000000003";
const ACTOR = "user-1";

let metaDoc: Y.Doc;

/**
 * A Hocuspocus stand-in whose direct connection hands out the fake meta doc.
 * @returns The stand-in.
 */
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
 * @param createdAt - Epoch millis.
 * @returns Nothing.
 */
function seedSpace(id: string, createdAt: number): void {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("type", "canvas");
  entry.set("name", id);
  entry.set("createdAt", createdAt);
  metaDoc.getMap("spaces").set(id, entry);
}

/**
 * Give a user an open-tab list holding exactly these ids.
 * @param userId - Whose list.
 * @param ids - What it holds, in order.
 * @returns Nothing.
 */
function seedTabs(userId: string, ids: string[]): void {
  const userMap = new Y.Map<unknown>();
  const list = new Y.Array<string>();
  metaDoc.getMap("perUser").set(userId, userMap);
  userMap.set("openTabIds", list);
  list.push(ids);
}

/**
 * Read a user's open-tab list out of the meta doc.
 * @param userId - Whose list.
 * @returns Its contents, or null when the user has no list.
 */
function readTabs(userId: string): string[] | null {
  const userMap = metaDoc.getMap<Y.Map<unknown>>("perUser").get(userId);
  const list = userMap?.get("openTabIds");
  return list instanceof Y.Array ? (list.toArray() as string[]) : null;
}

/**
 * Send one tab RPC as the given caller.
 * @param type - Which tab RPC.
 * @param payload - Its payload.
 * @returns The RPC response.
 */
async function tabRpc(
  type: "tab:open" | "tab:close" | "tab:reorder",
  payload: Record<string, unknown>,
): ReturnType<typeof handleSpaceRpc> {
  return handleSpaceRpc(
    { hocuspocus: makeHocuspocus() },
    PID,
    { userId: ACTOR, role: "editor" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { id: "r1", type, payload } as any,
  );
}

/**
 * Delete a Space through the real handler.
 * @param spaceId - Which Space.
 * @returns The RPC response.
 */
async function deleteSpace(
  spaceId: string,
): ReturnType<typeof handleSpaceRpc> {
  return handleSpaceRpc(
    { hocuspocus: makeHocuspocus() },
    PID,
    { userId: "someone-else", role: "owner" },
    { id: "d1", type: "space:delete", payload: { spaceId } },
  );
}

beforeEach(() => {
  metaDoc = new Y.Doc();
  softDeleteByNameMock.mockReset();
  softDeleteByNameMock.mockResolvedValue(true);
  restoreByNameMock.mockReset();
  restoreByNameMock.mockResolvedValue(true);
  seedInitialStateMock.mockReset();
  seedInitialStateMock.mockResolvedValue(true);
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

  seedSpace(OLDEST, 100);
  seedSpace(MIDDLE, 200);
  seedSpace(NEWEST, 300);
});

describe("first visit to a project", () => {
  it("seeds the newest Space alone", async () => {
    await seedOpenTabListOnFirstVisit(metaDoc, ACTOR);

    expect(readTabs(ACTOR)).toEqual([NEWEST]);
  });

  it("leaves a list that already exists alone", async () => {
    seedTabs(ACTOR, [OLDEST]);

    await seedOpenTabListOnFirstVisit(metaDoc, ACTOR);

    expect(readTabs(ACTOR)).toEqual([OLDEST]);
  });

  it("leaves an empty list alone — the owner closed those tabs", async () => {
    seedTabs(ACTOR, []);

    await seedOpenTabListOnFirstVisit(metaDoc, ACTOR);

    expect(readTabs(ACTOR)).toEqual([]);
  });

  // A list can end up holding nothing but ids of Spaces that are gone: the
  // sweep that removes a deleted Space from these lists walks the replica the
  // delete ran on, and a list written on another instance a moment earlier is
  // not there yet. Seeding leaves it as it stands all the same — whose list
  // it is decides who may write it, and putting it right belongs to its owner
  // (user 2026-09-11, #2140).
  it("leaves a list holding only dead ids as it stands", async () => {
    seedTabs(ACTOR, ["space-deleted-elsewhere"]);

    await seedOpenTabListOnFirstVisit(metaDoc, ACTOR);

    expect(readTabs(ACTOR)).toEqual(["space-deleted-elsewhere"]);
  });

  // `readTabs` answers null for "no list" and [] for a list that exists and
  // is empty, so this pins the second: the list is created, and the seed put
  // nothing in it because there was nothing to put.
  it("creates an empty list when the project has no Spaces", async () => {
    metaDoc.getMap("spaces").delete(OLDEST);
    metaDoc.getMap("spaces").delete(MIDDLE);
    metaDoc.getMap("spaces").delete(NEWEST);

    await seedOpenTabListOnFirstVisit(metaDoc, ACTOR);

    expect(readTabs(ACTOR)).toEqual([]);
  });
});

describe("seeding from a tab RPC follows the same rule", () => {
  // A tab RPC queued during the handshake is flushed BEFORE the connected
  // hook runs, so this path still seeds. Two seeding rules would put a
  // different bar on screen depending on which one got there first.

  it("tab:open seeds the newest Space, then adds the one being opened", async () => {
    const res = await tabRpc("tab:open", { spaceId: OLDEST });

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([NEWEST, OLDEST]);
  });

  it("tab:open on the newest Space leaves it there once", async () => {
    const res = await tabRpc("tab:open", { spaceId: NEWEST });

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([NEWEST]);
  });

  // Closing a tab that is not in the stored list writes nothing and still
  // answers ok: the caller's intent already holds. A list holding only dead
  // ids is the same case — the ids stay, because this call was not about
  // them.
  it("answers ok without writing when the tab is not in the list", async () => {
    seedTabs(ACTOR, ["space-deleted-elsewhere"]);

    const res = await tabRpc("tab:close", { spaceId: NEWEST });

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual(["space-deleted-elsewhere"]);
  });

  it("tab:close from no list at all ends with an empty list", async () => {
    // Seeding puts one tab up and that is the only tab on their screen, so
    // the close they just pressed is necessarily that one. An empty bar is
    // the honest outcome, and it is their own doing.
    const res = await tabRpc("tab:close", { spaceId: NEWEST });

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([]);
  });

  it("tab:reorder from no list at all seeds the newest Space", async () => {
    const res = await tabRpc("tab:reorder", {
      spaceId: NEWEST,
      beforeSpaceId: null,
    });

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([NEWEST]);
  });
});

describe("somebody else deletes the Space in a one-tab bar", () => {
  it("puts the newest remaining Space in its place", async () => {
    seedTabs(ACTOR, [NEWEST]);

    const res = await deleteSpace(NEWEST);

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([MIDDLE]);
  });

  it("leaves a bar that still holds something alone", async () => {
    seedTabs(ACTOR, [NEWEST, OLDEST]);

    const res = await deleteSpace(NEWEST);

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([OLDEST]);
  });

  it("leaves a bar the owner had already emptied alone", async () => {
    // Their own choice, and this delete did not touch it. Filling it here
    // would re-open a tab they closed.
    seedTabs(ACTOR, []);

    const res = await deleteSpace(NEWEST);

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([]);
  });

  it("leaves a member who has no list at all without one", async () => {
    // No list means "not decided yet", and the reader still gives them a
    // default. Writing one here would decide it on their behalf.
    const res = await deleteSpace(NEWEST);

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toBeNull();
  });
});

describe("restore does not put a tab back", () => {
  it("leaves the list empty after the restored Space is swept out of it", async () => {
    // The sweep runs on restore too, so a list holding exactly the restored
    // Space comes out empty. Putting the newest Space back HERE would hand
    // it straight back — which is the whole reason the refill lives in the
    // delete handler instead.
    seedTabs(ACTOR, [NEWEST]);
    activityLatestUnrestoredMock.mockResolvedValue({
      id: "act-del-1",
      projectId: PID,
      actorUserId: "someone-else",
      actorName: null,
      type: "space:deleted" as const,
      spaceId: NEWEST,
      nodeId: null,
      taskId: null,
      payload: {
        spaceName: NEWEST,
        spaceSnapshot: {
          id: NEWEST,
          type: "canvas",
          name: NEWEST,
          order: 2,
          locked: false,
          createdAt: 300,
          createdBy: "someone-else",
        },
      },
      restored: false,
      createdAt: 400,
    });
    metaDoc.getMap("spaces").delete(NEWEST);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "someone-else", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: NEWEST } },
    );

    expect(res.ok).toBe(true);
    expect(readTabs(ACTOR)).toEqual([]);
  });
});
