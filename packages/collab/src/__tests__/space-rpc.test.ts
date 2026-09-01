// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * space-rpc handler tests (ADR 2026-07-04 project-activity-feed).
 *
 * The audit trail moved from the meta-doc projectMessages Y.Array to
 * the PG project_activities table: every handler is asserted against
 * the mocked core projectActivitiesRepo instead of Y.Array contents,
 * and restore sources its snapshot from the mocked PG row. The Yjs
 * mutations themselves (meta.spaces writes) are still asserted against
 * a real Y.Doc.
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

// The yjs-store repo moved to collab; space-rpc imports it locally.
vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  softDeleteByName: softDeleteByNameMock,
  restoreByName: restoreByNameMock,
  seedInitialState: seedInitialStateMock,
  countLiveSpaceDocs: countLiveSpaceDocsMock,
}));

// The cross-instance delete lock is unit-tested in space-delete-lock.test.ts.
// Here we bypass it so the delete guard logic (PG authoritative count +
// type-correct content-doc naming) is tested in isolation: the default just
// runs the critical section directly (lock always acquired). The lock-busy
// path is its own test that overrides this to reject.
vi.mock("@collab/services/space-delete-lock.js", () => ({
  withSpaceDeleteLock: withSpaceDeleteLockMock,
  SpaceDeleteLockBusyError: FakeLockBusyError,
}));

// Spread the real core barrel (encodeInitialSpaceContent /
// writeSpaceEntry keep their real impls the Yjs-mutation assertions
// depend on) and override createLogger (no initCore under test) plus
// projectActivitiesRepo (no business DB under test).
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
  type SpaceRpcCaller,
} from "../services/space-rpc.js";
import {
  spaceContentDocName,
  documentBodyFragment,
  ACTIVITY_NEW_SIGNAL,
} from "@breatic/shared";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";

interface FakeDoc {
  doc: Y.Doc;
  disconnect: ReturnType<typeof vi.fn>;
  broadcastStateless: ReturnType<typeof vi.fn>;
}

let fakeMetaDoc: FakeDoc;

function makeHocuspocus(): Hocuspocus {
  return {
    openDirectConnection: vi.fn(async () => {
      return {
        // The real `DirectConnection` exposes the live Y.Doc as a public
        // field; read-only pre-checks use it so they never ask the store
        // for anything.
        document: fakeMetaDoc.doc,
        transact: async (fn: (doc: Y.Doc) => void) => {
          fn(fakeMetaDoc.doc);
        },
        disconnect: fakeMetaDoc.disconnect,
      };
    }),
    // The activity:new signal path looks the loaded meta doc up here
    // and calls broadcastStateless on it.
    documents: new Map([
      [
        `project-${PID}/meta`,
        { broadcastStateless: (payload: string) => fakeMetaDoc.broadcastStateless(payload) },
      ],
    ]),
  } as unknown as Hocuspocus;
}

/** Seed a spaces entry into the fake meta doc. */
function seedSpace(
  id: string,
  fields: Record<string, unknown>,
): void {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  for (const [k, v] of Object.entries(fields)) entry.set(k, v);
  fakeMetaDoc.doc.getMap("spaces").set(id, entry);
}

beforeEach(() => {
  fakeMetaDoc = {
    doc: new Y.Doc(),
    disconnect: vi.fn(async () => {}),
    broadcastStateless: vi.fn(),
  };
  softDeleteByNameMock.mockReset();
  restoreByNameMock.mockReset();
  seedInitialStateMock.mockReset();
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
  // Default: this instance wins the consume CAS (returns true).
  activityConsumeRestoreMock.mockResolvedValue(true);
});

/**
 * A well-formed uuid v4, standing in for the token a client generates per
 * click. The server stores it on the entry and echoes it in the broadcast;
 * the machine that sent it recognises the Space it asked for that way,
 * since it no longer chooses the id.
 */
const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("handleSpaceRpc — role validation", () => {
  it("space:create refuses viewer role", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u", role: "viewer" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    expect(activityInsertMock).not.toHaveBeenCalled();
  });

  it("space:delete refuses viewer role", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u", role: "viewer" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
  });

  it("space:lock refuses viewer role", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u", role: "viewer" },
      {
        id: "r1",
        type: "space:lock",
        payload: { spaceId: SID, locked: true },
      },
    );
    expect(res.ok).toBe(false);
  });

  it("space:restore refuses editor role (owner-only)", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u", role: "editor" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
  });
});

describe("handleSpaceRpc — happy paths write PG activity rows", () => {
  it("space:create mints the id, writes meta.spaces + inserts a space:created activity row + broadcasts the signal", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );
    expect(res.ok).toBe(true);
    // The caller learns the id from the reply — it did not choose one.
    const newId = res.ok && res.result && "spaceId" in res.result ? res.result.spaceId : undefined;
    expect(newId).toBeTruthy();
    expect(fakeMetaDoc.doc.getMap("spaces").has(newId!)).toBe(true);
    expect(seedInitialStateMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, newId!, "canvas"),
      expect.any(Uint8Array),
    );
    expect(activityInsertMock).toHaveBeenCalledWith({
      projectId: PID,
      actorUserId: "u-1",
      type: "space:created",
      spaceId: newId,
      payload: { spaceName: "Main" },
    });
    // Live signal so connected members refetch the feed.
    expect(fakeMetaDoc.broadcastStateless).toHaveBeenCalledWith(
      JSON.stringify({ t: ACTIVITY_NEW_SIGNAL, projectId: PID }),
    );
  });

  // The assertion above only says bytes were passed. Which bytes matters: a
  // document Space whose body arrives empty costs the first person who undoes
  // back to nothing both their text and their redo stack. Hardcoding the kind
  // at this call site left the whole suite green while every document Space
  // created here shipped that way.
  it("space:create gives a document Space a body, and a canvas none", async () => {
    /**
     * Create a Space of one kind and decode the content bytes it seeded.
     * @param type - The Space kind to create.
     * @returns The Y.Doc the seeded bytes decode to.
     */
    async function seededContentDoc(type: 'canvas' | 'document'): Promise<Y.Doc> {
      seedInitialStateMock.mockClear();
      const res = await handleSpaceRpc(
        { hocuspocus: makeHocuspocus() },
        PID,
        { userId: "u-1", role: "editor" },
        {
          id: "r-seed",
          type: "space:create",
          payload: { type, name: "S", claimToken: TOKEN },
        },
      );
      expect(res.ok).toBe(true);
      const id = res.ok && res.result && "spaceId" in res.result ? res.result.spaceId : undefined;
      const name = spaceContentDocName(PID, id!, type);
      const call = seedInitialStateMock.mock.calls.find((c) => c[0] === name);
      expect(call).toBeDefined();
      const doc = new Y.Doc();
      Y.applyUpdate(doc, call?.[1] as Uint8Array);
      return doc;
    }

    // Empty on purpose: a document starts with no blocks at all (#121 定稿
    // §6.2)。创建者输入的名字只住在 meta 的 Space 条目上。
    const body = documentBodyFragment(await seededContentDoc("document"));
    expect(body.length).toBe(0);

    expect((await seededContentDoc("canvas")).share.size).toBe(0);
  });

  it("space:create puts the caller's claim token on the entry", async () => {
    // How the requesting machine recognises the Space it asked for once
    // the entry is broadcast: it no longer knows the id, so it watches for
    // the token it generated. Only that machine has it.
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );
    const newId = res.ok && res.result && "spaceId" in res.result ? res.result.spaceId : undefined;
    const entry = fakeMetaDoc.doc
      .getMap("spaces")
      .get(newId!) as Y.Map<unknown>;
    expect(entry.get("claimToken")).toBe(TOKEN);
  });

  it("space:create mints a different id on every call", async () => {
    // The old CONFLICT-on-duplicate case is gone with the client-chosen
    // id: nobody can submit an id at all, so the only way to collide is a
    // uuid v4 collision. The handler still refuses to overwrite an
    // existing entry — that guard costs one line and protects data — but
    // it is not reachable by any input, so what is pinned here is the
    // property that actually holds: two creates never land on one id.
    const mk = async (name: string): Promise<string | undefined> => {
      const res = await handleSpaceRpc(
        { hocuspocus: makeHocuspocus() },
        PID,
        { userId: "u-1", role: "editor" },
        {
          id: "r",
          type: "space:create",
          payload: { type: "canvas", name, claimToken: TOKEN },
        },
      );
      return res.ok && res.result && "spaceId" in res.result ? res.result.spaceId : undefined;
    };
    const first = await mk("One");
    const second = await mk("Two");
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    expect(fakeMetaDoc.doc.getMap("spaces").size).toBe(2);
  });

  it("activity insert failure does NOT fail the RPC (best-effort audit - the Yjs mutation already applied)", async () => {
    activityInsertMock.mockRejectedValue(new Error("pg down"));
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: TOKEN },
      },
    );
    expect(res.ok).toBe(true);
    const newId = res.ok && res.result && "spaceId" in res.result ? res.result.spaceId : undefined;
    expect(fakeMetaDoc.doc.getMap("spaces").has(newId!)).toBe(true);
  });

  it("space:delete removes the meta entry + inserts space:deleted with the snapshot payload + soft-deletes content rows", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", locked: false, order: 0 });
    seedSpace("sp-sibling", { type: "canvas", name: "Sibling" });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(false);
    // The space:deleted row carries the FULL directory-entry snapshot
    // that space:restore consumes; the canvas CONTENT doc is only
    // soft-deleted (below), never snapshotted.
    expect(activityInsertMock).toHaveBeenCalledWith({
      projectId: PID,
      actorUserId: "u-1",
      type: "space:deleted",
      spaceId: SID,
      payload: {
        spaceName: "Main",
        spaceSnapshot: expect.objectContaining({
          id: SID,
          type: "canvas",
          name: "Main",
        }),
      },
    });
    expect(softDeleteByNameMock).toHaveBeenCalledWith(
      `project-${PID}/canvas-${SID}`,
    );
  });

  it("space:delete returns NOT_FOUND when spaceId is absent", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: "missing" } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(activityInsertMock).not.toHaveBeenCalled();
  });

  it("space:delete refuses to delete the LAST remaining space (project keeps >=1, no activity row)", async () => {
    countLiveSpaceDocsMock.mockResolvedValue(1);
    seedSpace(SID, { type: "canvas", name: "Only" });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(true);
    expect(softDeleteByNameMock).not.toHaveBeenCalled();
    expect(activityInsertMock).not.toHaveBeenCalled();
  });

  it("space:delete uses the PG authoritative count, not in-memory spaces.size (multi-instance safety)", async () => {
    seedSpace(SID, { type: "canvas", name: "A" });
    seedSpace("sp-b", { type: "canvas", name: "B" });
    countLiveSpaceDocsMock.mockResolvedValue(1); // PG authority: only 1 live

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(true);
    expect(softDeleteByNameMock).not.toHaveBeenCalled();
  });

  it("space:delete soft-deletes the content doc named by the space TYPE, not hardcoded canvas", async () => {
    seedSpace(SID, { type: "document", name: "Doc" });
    seedSpace("sp-sib", { type: "canvas" });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(softDeleteByNameMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "document"),
    );
  });

  it("space:delete soft-deletes ALL name variants when meta.type is missing (corruption-robust)", async () => {
    seedSpace(SID, { name: "Corrupt" }); // deliberately no `type`
    seedSpace("sp-sib", { type: "canvas" });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    for (const kind of ["canvas", "document", "timeline"] as const) {
      expect(softDeleteByNameMock).toHaveBeenCalledWith(
        spaceContentDocName(PID, SID, kind),
      );
    }
  });

  it("space:delete maps a busy cross-instance lock to CONFLICT", async () => {
    withSpaceDeleteLockMock.mockRejectedValue(new FakeLockBusyError("busy"));
    seedSpace(SID, { type: "canvas", name: "Main" });
    seedSpace("sp-sib", { type: "canvas" });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
  });

  it("space:lock true/false inserts space:locked / space:unlocked rows", async () => {
    seedSpace(SID, { type: "canvas", name: "Main", locked: false });

    let res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:lock", payload: { spaceId: SID, locked: true } },
    );
    expect(res.ok).toBe(true);
    expect(activityInsertMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "space:locked", spaceId: SID }),
    );

    res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r2", type: "space:lock", payload: { spaceId: SID, locked: false } },
    );
    expect(res.ok).toBe(true);
    expect(activityInsertMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "space:unlocked", spaceId: SID }),
    );
  });

  it("space:rename inserts space:renamed with old + new names", async () => {
    seedSpace(SID, { type: "canvas", name: "Old", locked: false });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "New" } },
    );
    expect(res.ok).toBe(true);
    expect(activityInsertMock).toHaveBeenCalledWith({
      projectId: PID,
      actorUserId: "u-1",
      type: "space:renamed",
      spaceId: SID,
      payload: { spaceName: "New", oldSpaceName: "Old" },
    });
  });

  it("space:rename same-name no-op writes NO activity row", async () => {
    seedSpace(SID, { type: "canvas", name: "Same", locked: false });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "Same" } },
    );
    expect(res.ok).toBe(true);
    expect(activityInsertMock).not.toHaveBeenCalled();
  });

  it("space:rename refuses when the space is locked", async () => {
    seedSpace(SID, { type: "canvas", name: "Old", locked: true });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:rename", payload: { spaceId: SID, name: "New" } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    expect(activityInsertMock).not.toHaveBeenCalled();
  });
});

describe("handleSpaceRpc — restore sources from the PG activity row", () => {
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

  it("returns NOT_FOUND when no unconsumed space:deleted row exists", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(null);
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(activityConsumeRestoreMock).not.toHaveBeenCalled();
  });

  it("rebuilds the meta entry from the row snapshot, un-deletes ALL content variants, consumes the row + appends space:restored", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    const rebuilt = fakeMetaDoc.doc.getMap("spaces").get(SID) as Y.Map<unknown>;
    expect(rebuilt.get("name")).toBe("Main");
    expect(rebuilt.get("type")).toBe("canvas");
    for (const kind of ["canvas", "document", "timeline"] as const) {
      expect(restoreByNameMock).toHaveBeenCalledWith(
        spaceContentDocName(PID, SID, kind),
      );
    }
    expect(activityConsumeRestoreMock).toHaveBeenCalledWith("act-del-1", {
      projectId: PID,
      actorUserId: "owner-1",
      type: "space:restored",
      spaceId: SID,
      payload: { spaceName: "Main" },
    });
    // Won the CAS → the activity:new signal is broadcast.
    expect(fakeMetaDoc.broadcastStateless).toHaveBeenCalledWith(
      JSON.stringify({ t: ACTIVITY_NEW_SIGNAL, projectId: PID }),
    );
  });

  it("does NOT broadcast when the consume CAS is lost (a concurrent cross-instance restore already consumed the row)", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);
    // This instance rebuilt the entry but LOST the consume race.
    activityConsumeRestoreMock.mockResolvedValue(false);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    // No duplicate space:restored signal — the winner already broadcast.
    expect(fakeMetaDoc.broadcastStateless).not.toHaveBeenCalled();
  });

  it("maps a busy cross-instance lock to CONFLICT (restore serializes under the delete lock)", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);
    withSpaceDeleteLockMock.mockRejectedValue(new FakeLockBusyError("busy"));

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
  });

  it("returns CONFLICT and does NOT consume the row when the space already exists (retry-safety guard)", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);
    seedSpace(SID, { type: "canvas", name: "Main" });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    expect(activityConsumeRestoreMock).not.toHaveBeenCalled();
    expect(restoreByNameMock).not.toHaveBeenCalled();
  });

  it("a consume/append failure after the rebuild still returns ok (space is already restored; logged for repair)", async () => {
    activityLatestUnrestoredMock.mockResolvedValue(DELETED_ROW);
    activityConsumeRestoreMock.mockRejectedValue(new Error("pg down"));

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(true);
  });

  it("rejects a malformed snapshot (non-object) as NOT_FOUND instead of rebuilding garbage", async () => {
    activityLatestUnrestoredMock.mockResolvedValue({
      ...DELETED_ROW,
      payload: { spaceName: "Main", spaceSnapshot: "corrupted" },
    });

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(false);
  });
});

// ── Task #27: the open-tab list moves behind RPCs ────────────────────────
//
// It was the one part of the meta doc a client wrote directly, and that
// single exception is why the write gate had to understand which field an
// incoming frame touched. With it behind an RPC the rule is flat — a client
// never writes that doc — and the connection is simply read-only.
//
// The seeding rule below is not new behaviour invented here: it is the
// existing client-side rule, moved. Getting it wrong server-side is worse
// than getting it wrong in a browser tab, because the result is persisted
// and every machine on the account sees it.

/**
 * Read a user's open-tab list out of the fake meta doc.
 * @param userId - Whose list to read.
 * @returns The ids in the list, or null when the user has no list at all.
 */
function readTabs(userId: string): string[] | null {
  const perUser = fakeMetaDoc.doc.getMap("perUser");
  const userMap = perUser.get(userId) as Y.Map<unknown> | undefined;
  if (!userMap) return null;
  const arr = userMap.get("openTabIds") as Y.Array<string> | undefined;
  return arr ? arr.toArray() : null;
}

/** Give a user a perUser record that has no openTabIds list. */
function seedRecordWithoutList(userId: string): void {
  fakeMetaDoc.doc.getMap("perUser").set(userId, new Y.Map<unknown>());
}

describe("handleSpaceRpc — tab:open / tab:close", () => {
  const A = "sp-a";
  const B = "sp-b";
  const C = "sp-c";
  // Typed as the handler's own caller shape so the viewer case below is
  // not narrowed to "editor" by the default argument.
  const editor: SpaceRpcCaller = { userId: "u-1", role: "editor" };

  beforeEach(() => {
    seedSpace(A, { type: "canvas", name: "A", order: 0 });
    seedSpace(B, { type: "canvas", name: "B", order: 1 });
    seedSpace(C, { type: "canvas", name: "C", order: 2 });
  });

  const open = (spaceId: string, caller = editor) =>
    handleSpaceRpc({ hocuspocus: makeHocuspocus() }, PID, caller, {
      id: "r",
      type: "tab:open",
      payload: { spaceId },
    });

  const close = (spaceId: string, caller = editor) =>
    handleSpaceRpc({ hocuspocus: makeHocuspocus() }, PID, caller, {
      id: "r",
      type: "tab:close",
      payload: { spaceId },
    });

  it("refuses to open a tab for a Space that does not exist", async () => {
    const res = await open("sp-missing");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(readTabs("u-1")).toBeNull();
  });

  it("seeds the list with every existing Space on a user's first open", async () => {
    // No record yet means the tab bar shows ALL Spaces. Writing just the
    // one that was clicked would silently drop the others — and it is
    // persisted now, so all of that user's machines lose them and a
    // reload does not bring them back. This bug was fixed once already in
    // the client; the rule moves with the code.
    expect(readTabs("u-1")).toBeNull();
    const res = await open(B);
    expect(res.ok).toBe(true);
    expect(readTabs("u-1")).toEqual([A, B, C]);
  });

  it("seeds on a first CLOSE too, then removes the one closed", async () => {
    // Closing without ever opening is a real path: the tab bar is showing
    // every Space, and the user closes one of them. Seeding first is what
    // makes "close one" mean "keep the other two" instead of "keep none".
    const res = await close(A);
    expect(res.ok).toBe(true);
    expect(readTabs("u-1")).toEqual([B, C]);
  });

  it("seeds when the record exists but has no list", async () => {
    // A shape that exists in production today: the old client-side close
    // created the record and then returned without making a list. The
    // gate is the LIST, not the record — gating on the record would skip
    // seeding for exactly these users and leave their tab bar empty.
    seedRecordWithoutList("u-1");
    const res = await open(B);
    expect(res.ok).toBe(true);
    expect(readTabs("u-1")).toEqual([A, B, C]);
  });

  it("opening an already-open tab changes nothing", async () => {
    await open(B);
    const before = readTabs("u-1");
    let updates = 0;
    const count = (): void => {
      updates += 1;
    };
    fakeMetaDoc.doc.on("update", count);
    const res = await open(B);
    fakeMetaDoc.doc.off("update", count);
    expect(res.ok).toBe(true);
    expect(readTabs("u-1")).toEqual(before);
    expect(updates).toBe(0);
  });

  it("closing a tab that is not open changes nothing", async () => {
    await open(B); // seeds [A, B, C]
    await close(A); // -> [B, C]
    const before = readTabs("u-1");
    const res = await close(A);
    expect(res.ok).toBe(true);
    expect(readTabs("u-1")).toEqual(before);
  });

  it("writes no activity row for either operation", async () => {
    // Which tabs someone has open is their own window state, not a
    // project event. This is the line between the tab RPCs and the five
    // Space operations.
    await open(B);
    await close(B);
    expect(activityInsertMock).not.toHaveBeenCalled();
    expect(activityInsertIgnoreMock).not.toHaveBeenCalled();
  });

  it("lets a viewer manage their own tabs", async () => {
    // A viewer cannot change the project, but their tab bar is theirs.
    // Their connection is read-only, which is exactly why this has to go
    // through an RPC — before this change their tab state was silently
    // dropped by the server and never survived a reload.
    const res = await open(B, { userId: "u-viewer", role: "viewer" });
    expect(res.ok).toBe(true);
    expect(readTabs("u-viewer")).toEqual([A, B, C]);
  });

  it("writes to the caller's own record, never another user's", async () => {
    await open(B, { userId: "u-1", role: "editor" });
    await open(C, { userId: "u-2", role: "editor" });
    expect(readTabs("u-1")).toEqual([A, B, C]);
    expect(readTabs("u-2")).toEqual([A, B, C]);
    // Two separate records, each seeded on its own first write.
    expect(fakeMetaDoc.doc.getMap("perUser").size).toBe(2);
  });
});

describe("handleSpaceRpc — a deleted Space leaves everyone's tab bar", () => {
  const A = "sp-a";
  const B = "sp-b";
  const editor: SpaceRpcCaller = { userId: "u-1", role: "editor" };

  beforeEach(() => {
    seedSpace(A, { type: "canvas", name: "A", order: 0 });
    seedSpace(B, { type: "canvas", name: "B", order: 1 });
  });

  const openFor = (userId: string, spaceId: string) =>
    handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId, role: "editor" },
      { id: "r", type: "tab:open", payload: { spaceId } },
    );

  it("clears the deleted Space from every user's list", async () => {
    // Nobody's client can clean this up any more: clients do not write
    // the meta doc. Leaving it to each client would also mean the tab
    // only disappears for the people who happen to be online.
    await openFor("u-1", A);
    await openFor("u-2", A);
    await openFor("u-3", A);
    expect(readTabs("u-1")).toContain(A);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      editor,
      { id: "r", type: "space:delete", payload: { spaceId: A } },
    );

    expect(res.ok).toBe(true);
    expect(fakeMetaDoc.doc.getMap("spaces").has(A)).toBe(false);
    for (const u of ["u-1", "u-2", "u-3"]) {
      expect(readTabs(u), u).not.toContain(A);
      // The other Space is untouched — this clears one entry, not the list.
      expect(readTabs(u), u).toContain(B);
    }
  });

  it("leaves users who never had that tab open alone", async () => {
    await openFor("u-1", A);
    const before = readTabs("u-1");
    // u-2 has no record at all; deleting must not conjure one for them.
    await handleSpaceRpc({ hocuspocus: makeHocuspocus() }, PID, editor, {
      id: "r",
      type: "space:delete",
      payload: { spaceId: B },
    });
    expect(readTabs("u-2")).toBeNull();
    expect(before).not.toBeNull();
  });

  it("does not manufacture a list for someone who has a record but no list", async () => {
    // "No list" means the tab bar shows every Space. Giving that user an
    // empty list while sweeping would flip them to showing nothing — the
    // sweep would empty a tab bar it was only supposed to remove one
    // entry from. They have no list to clean, so they are left alone.
    seedRecordWithoutList("u-2");
    await handleSpaceRpc({ hocuspocus: makeHocuspocus() }, PID, editor, {
      id: "r",
      type: "space:delete",
      payload: { spaceId: A },
    });
    expect(readTabs("u-2")).toBeNull();
  });

  it("restore clears stale tab entries as a backstop", async () => {
    // The cross-instance window: a tab:open can land after delete's sweep
    // on another instance, leaving an entry pointing at a Space that is
    // gone. Nobody sees it — the tab bar drops ids it cannot resolve — but
    // when the Space comes back the id resolves again and the tab appears
    // out of nowhere, which contradicts "restore does not restore tabs".
    await openFor("u-1", A);
    await handleSpaceRpc({ hocuspocus: makeHocuspocus() }, PID, editor, {
      id: "r1",
      type: "space:delete",
      payload: { spaceId: A },
    });
    // Feed restore the snapshot the delete just wrote, so this exercises
    // the real path rather than a stub that always says "nothing to
    // restore".
    const deleteRow = activityInsertMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "space:deleted",
    );
    expect(deleteRow).toBeDefined();
    activityLatestUnrestoredMock.mockResolvedValue({
      id: "act-1",
      payload: (deleteRow![0] as { payload: unknown }).payload,
    });

    // Simulate the straggler that the sweep missed.
    const userMap = fakeMetaDoc.doc
      .getMap("perUser")
      .get("u-1") as Y.Map<unknown>;
    (userMap.get("openTabIds") as Y.Array<string>).push([A]);
    expect(readTabs("u-1")).toContain(A);

    await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r2", type: "space:restore", payload: { spaceId: A } },
    );

    expect(fakeMetaDoc.doc.getMap("spaces").has(A)).toBe(true);
    expect(readTabs("u-1")).not.toContain(A);
  });
});
