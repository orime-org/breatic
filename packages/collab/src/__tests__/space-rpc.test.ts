// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

// Spread the real core barrel (encodeInitialSpaceContentState /
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

import { handleSpaceRpc } from "../services/space-rpc.js";
import { spaceContentDocName, ACTIVITY_NEW_SIGNAL } from "@breatic/shared";

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

describe("handleSpaceRpc — role validation", () => {
  it("space:create refuses viewer role", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u", role: "viewer" },
      {
        id: "r1",
        type: "space:create",
        payload: { spaceId: SID, type: "canvas", name: "Main" },
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
  it("space:create writes meta.spaces + inserts a space:created activity row + broadcasts the signal", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { spaceId: SID, type: "canvas", name: "Main" },
      },
    );
    expect(res.ok).toBe(true);
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(true);
    expect(seedInitialStateMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "canvas"),
      expect.any(Uint8Array),
    );
    expect(activityInsertMock).toHaveBeenCalledWith({
      projectId: PID,
      actorUserId: "u-1",
      type: "space:created",
      spaceId: SID,
      payload: { spaceName: "Main" },
    });
    // Live signal so connected members refetch the feed.
    expect(fakeMetaDoc.broadcastStateless).toHaveBeenCalledWith(
      JSON.stringify({ t: ACTIVITY_NEW_SIGNAL, projectId: PID }),
    );
  });

  it("space:create returns CONFLICT when spaceId already exists (no activity row)", async () => {
    seedSpace(SID, {});
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:create",
        payload: { spaceId: SID, type: "canvas", name: "Duplicate" },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    expect(activityInsertMock).not.toHaveBeenCalled();
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
        payload: { spaceId: SID, type: "canvas", name: "Main" },
      },
    );
    expect(res.ok).toBe(true);
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(true);
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
