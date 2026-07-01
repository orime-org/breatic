// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Smoke tests for collab space-rpc handlers.
 *
 * Pins the role-validation matrix + dispatch routing + basic
 * happy/error response shapes. Full Yjs-mutation behavior is covered
 * by the integration smoke run (where the frontend wires onto these
 * RPCs end-to-end with a real collab + PG).
 *
 * Mock surface:
 *   - hocuspocus.openDirectConnection — returns a fake DirectConnection
 *     whose `transact(fn)` runs `fn` against a backing Y.Doc that the
 *     test inspects after the handler returns.
 *   - @breatic/core `yjsDocumentsRepo` — the canvas-row soft-delete /
 *     restore now route through the shared core repo (the single home
 *     for `yjs_documents` SQL); the two writers are vi.fn() stubs the
 *     handlers call. Mocking the whole barrel also keeps the real core
 *     module (and its `ai`/otel transitive deps) out of the vitest ESM
 *     resolver.
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
} = vi.hoisted(() => ({
  softDeleteByNameMock: vi.fn(),
  restoreByNameMock: vi.fn(),
  seedInitialStateMock: vi.fn(),
  countLiveSpaceDocsMock: vi.fn(),
  withSpaceDeleteLockMock: vi.fn(),
  FakeLockBusyError: class FakeLockBusyError extends Error {},
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

// `createLogger` now comes from `@breatic/core` (the unified logger), which
// reads the injected config at call time. Spread the real core barrel (so
// `encodeInitialSpaceContentState` / `writeSpaceEntry` keep their real impls
// the Yjs-mutation assertions depend on) and override only `createLogger`
// with a no-op stub so the module-level `createLogger("space-rpc")` doesn't
// require initCore under test.
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
  };
});

import { handleSpaceRpc } from "../services/space-rpc.js";
import { spaceContentDocName } from "@breatic/shared";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";

interface FakeDoc {
  doc: Y.Doc;
  disconnect: ReturnType<typeof vi.fn>;
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
  } as unknown as Hocuspocus;
}

beforeEach(() => {
  fakeMetaDoc = {
    doc: new Y.Doc(),
    disconnect: vi.fn(async () => {}),
  };
  softDeleteByNameMock.mockReset();
  restoreByNameMock.mockReset();
  seedInitialStateMock.mockReset();
  // Default: PG says the project has >=2 live spaces, so a delete proceeds
  // unless a test overrides it. The guard trusts this PG count, not the
  // in-memory spaces.size.
  countLiveSpaceDocsMock.mockReset();
  countLiveSpaceDocsMock.mockResolvedValue(2);
  // Default: the per-project delete lock is always acquired — run the
  // critical section directly.
  withSpaceDeleteLockMock.mockReset();
  withSpaceDeleteLockMock.mockImplementation(
    async (_projectId: string, fn: () => Promise<unknown>) => fn(),
  );
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

  it("messages:clear refuses editor role (owner-only)", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u", role: "editor" },
      { id: "r1", type: "messages:clear", payload: { all: true } },
    );
    expect(res.ok).toBe(false);
  });
});

describe("handleSpaceRpc — happy paths", () => {
  it("space:create writes meta.spaces + pushes projectMessages", async () => {
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
    const spaces = fakeMetaDoc.doc.getMap("spaces");
    expect(spaces.has(SID)).toBe(true);
    // The new Space's content doc is seeded (so it exists by the time the
    // Space is visible in meta — same invariant lazy-seed upholds).
    expect(seedInitialStateMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "canvas"),
      expect.any(Uint8Array),
    );
    const messages = fakeMetaDoc.doc.getArray("projectMessages");
    expect(messages.length).toBe(1);
    const m = messages.get(0) as Y.Map<unknown>;
    expect(m.get("kind")).toBe("space-created");
    expect(m.get("spaceId")).toBe(SID);
    // Q11 v2.1: actor is the caller's userId (UUID) for live
    // username lookup; spaceName is captured as SNAPSHOT at event
    // time and frozen — rename will push a `space-renamed` audit
    // entry rather than mutating history.
    expect(m.get("actor")).toBe("u-1");
    expect(m.get("spaceName")).toBe("Main");
  });

  it("space:create returns CONFLICT when spaceId already exists", async () => {
    const existing = new Y.Map();
    existing.set("id", SID);
    fakeMetaDoc.doc.getMap("spaces").set(SID, existing);

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
  });

  it("space:delete removes meta.spaces entry + pushes 'space-deleted' with snapshot + soft-deletes the canvas row", async () => {
    const existing = new Y.Map();
    existing.set("id", SID);
    existing.set("type", "canvas");
    existing.set("name", "Main");
    existing.set("locked", false);
    existing.set("order", 0);
    fakeMetaDoc.doc.getMap("spaces").set(SID, existing);
    // A second space so SID is NOT the last one (deleting the last is refused
    // — covered by its own test). Deleting a non-last space succeeds.
    const sibling = new Y.Map();
    sibling.set("id", "sp-sibling");
    sibling.set("type", "canvas");
    sibling.set("name", "Sibling");
    fakeMetaDoc.doc.getMap("spaces").set("sp-sibling", sibling);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(false);
    const m = fakeMetaDoc.doc.getArray("projectMessages").get(0) as Y.Map<unknown>;
    expect(m.get("kind")).toBe("space-deleted");
    // Q11 v2.1: spaceName snapshot is the rendered display value
    // (frozen at delete time); spaceSnapshot is the FULL entry kept
    // around so a future Restore can re-hydrate the Space.
    expect(m.get("spaceName")).toBe("Main");
    expect(m.get("spaceSnapshot")).toMatchObject({
      id: SID,
      type: "canvas",
      name: "Main",
    });
    // The canvas-{spaceId} row is soft-deleted via the core repo with
    // the canonical doc name.
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
  });

  it("space:delete refuses to delete the LAST remaining space (project keeps >=1)", async () => {
    // The authoritative PG count says only one live space remains. The
    // server is the authoritative guard (frontend also disables the button,
    // but a race / collaborator could still try). It must refuse without
    // removing the entry or soft-deleting the content row.
    countLiveSpaceDocsMock.mockResolvedValue(1);
    const only = new Y.Map();
    only.set("id", SID);
    only.set("type", "canvas");
    only.set("name", "Only");
    fakeMetaDoc.doc.getMap("spaces").set(SID, only);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    // Entry still there, content row NOT soft-deleted.
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(true);
    expect(softDeleteByNameMock).not.toHaveBeenCalled();
  });

  it("space:delete uses the PG authoritative count, not in-memory spaces.size (multi-instance safety)", async () => {
    // TWO spaces are visible in THIS instance's in-memory meta doc, but the
    // authoritative PG count says only one live space remains — a delete on
    // another instance hasn't propagated via pub/sub yet. The guard MUST
    // trust PG, not the stale in-memory size, or the project races to zero.
    const a = new Y.Map();
    a.set("id", SID);
    a.set("type", "canvas");
    a.set("name", "A");
    fakeMetaDoc.doc.getMap("spaces").set(SID, a);
    const b = new Y.Map();
    b.set("id", "sp-b");
    b.set("type", "canvas");
    b.set("name", "B");
    fakeMetaDoc.doc.getMap("spaces").set("sp-b", b);
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
    // A document-type space: its content doc is `document-{id}`, NOT
    // `canvas-{id}`. The delete must soft-delete the type-correct row or the
    // PG space count won't decrement (breaking the authoritative guard).
    const docSpace = new Y.Map();
    docSpace.set("id", SID);
    docSpace.set("type", "document");
    docSpace.set("name", "Doc");
    fakeMetaDoc.doc.getMap("spaces").set(SID, docSpace);
    const sib = new Y.Map();
    sib.set("id", "sp-sib");
    sib.set("type", "canvas");
    fakeMetaDoc.doc.getMap("spaces").set("sp-sib", sib);

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

  it("space:delete soft-deletes the real content row even when meta.type is missing (all variants, corruption-robust)", async () => {
    // A space whose meta entry lost its `type` field (data corruption). The
    // delete targets ALL content-doc name variants for the spaceId, so the
    // real row is soft-deleted regardless — otherwise the authoritative count
    // would keep counting a ghost row and could be inflated past the >=1 floor.
    const corrupt = new Y.Map();
    corrupt.set("id", SID);
    // deliberately NO "type" field
    corrupt.set("name", "Corrupt");
    fakeMetaDoc.doc.getMap("spaces").set(SID, corrupt);
    const sib = new Y.Map();
    sib.set("id", "sp-sib");
    sib.set("type", "canvas");
    fakeMetaDoc.doc.getMap("spaces").set("sp-sib", sib);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(softDeleteByNameMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "canvas"),
    );
    expect(softDeleteByNameMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "document"),
    );
    expect(softDeleteByNameMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "timeline"),
    );
  });

  it("space:delete returns CONFLICT when another delete holds the project lock", async () => {
    const a = new Y.Map();
    a.set("id", SID);
    a.set("type", "canvas");
    a.set("name", "A");
    fakeMetaDoc.doc.getMap("spaces").set(SID, a);
    const b = new Y.Map();
    b.set("id", "sp-b");
    b.set("type", "canvas");
    fakeMetaDoc.doc.getMap("spaces").set("sp-b", b);
    // Another instance's delete holds the per-project lock.
    withSpaceDeleteLockMock.mockRejectedValue(new FakeLockBusyError("busy"));

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    // The delete did not go through.
    expect(fakeMetaDoc.doc.getMap("spaces").has(SID)).toBe(true);
  });

  it("space:lock toggles entry.locked + pushes correct kind", async () => {
    const existing = new Y.Map();
    existing.set("id", SID);
    existing.set("name", "Main");
    existing.set("locked", false);
    fakeMetaDoc.doc.getMap("spaces").set(SID, existing);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:lock",
        payload: { spaceId: SID, locked: true },
      },
    );
    expect(res.ok).toBe(true);
    expect(existing.get("locked")).toBe(true);
    const m = fakeMetaDoc.doc.getArray("projectMessages").get(0) as Y.Map<unknown>;
    expect(m.get("kind")).toBe("space-locked");
  });

  it("space:rename updates entry.name + pushes space-renamed with both old and new names", async () => {
    const existing = new Y.Map();
    existing.set("id", SID);
    existing.set("name", "Old Name");
    existing.set("type", "canvas");
    existing.set("locked", false);
    fakeMetaDoc.doc.getMap("spaces").set(SID, existing);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:rename",
        payload: { spaceId: SID, name: "New Name" },
      },
    );
    expect(res.ok).toBe(true);
    expect(existing.get("name")).toBe("New Name");
    const m = fakeMetaDoc.doc.getArray("projectMessages").get(0) as Y.Map<unknown>;
    expect(m.get("kind")).toBe("space-renamed");
    expect(m.get("actor")).toBe("u-1");
    expect(m.get("spaceId")).toBe(SID);
    // spaceName carries the NEW name (post-rename); oldSpaceName carries
    // the pre-rename name — the frontend renders "X renamed Foo → Bar".
    expect(m.get("spaceName")).toBe("New Name");
    expect(m.get("oldSpaceName")).toBe("Old Name");
  });

  it("space:rename returns NOT_FOUND for missing spaceId (no message pushed)", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:rename",
        payload: { spaceId: "missing", name: "Whatever" },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(fakeMetaDoc.doc.getArray("projectMessages").length).toBe(0);
  });

  it("space:rename refuses locked Space (no rename, no message pushed)", async () => {
    const locked = new Y.Map();
    locked.set("id", SID);
    locked.set("name", "Locked");
    locked.set("locked", true);
    fakeMetaDoc.doc.getMap("spaces").set(SID, locked);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "u-1", role: "editor" },
      {
        id: "r1",
        type: "space:rename",
        payload: { spaceId: SID, name: "Should not stick" },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    expect(locked.get("name")).toBe("Locked");
    expect(fakeMetaDoc.doc.getArray("projectMessages").length).toBe(0);
  });

  it("space:restore rebuilds entry from latest space-deleted snapshot (owner) + marks original deleted entry restored=true + restores the canvas row", async () => {
    // Seed: pretend a delete already happened — projectMessages has a
    // space-deleted entry with a full snapshot, meta.spaces is empty.
    const deletedMsg = new Y.Map();
    deletedMsg.set("id", "pm-1");
    deletedMsg.set("kind", "space-deleted");
    deletedMsg.set("spaceId", SID);
    deletedMsg.set("spaceSnapshot", {
      id: SID,
      type: "canvas",
      name: "Restored Me",
      order: 0,
      locked: false,
      createdAt: 1000,
    });
    deletedMsg.set("createdAt", 1500);
    fakeMetaDoc.doc.getArray("projectMessages").push([deletedMsg]);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    const restored = fakeMetaDoc.doc.getMap("spaces").get(SID) as Y.Map<unknown>;
    expect(restored.get("name")).toBe("Restored Me");
    // The canvas-{spaceId} row's deleted_at is cleared via the core repo.
    expect(restoreByNameMock).toHaveBeenCalledWith(
      `project-${PID}/canvas-${SID}`,
    );
    // and a space-restored projectMessage was pushed
    expect(fakeMetaDoc.doc.getArray("projectMessages").length).toBe(2);
    // 2026-05-27 — original deleted entry is now marked restored=true
    // so the bell sheet can render a disabled "已恢复" badge without
    // a second round-trip. Same transact as the rebuild above —
    // peers receive the atomic 3-tuple (spaces.set + new restored
    // entry + restored flag) in one update.
    expect(deletedMsg.get("restored")).toBe(true);
  });

  it("space:restore clears the content doc named by the space TYPE (document), not hardcoded canvas", async () => {
    // Mirror of the delete naming fix: a document-type space's content doc is
    // `document-{id}`. Restore must clear THAT row (from the snapshot type),
    // or a delete->restore cycle would leave the real content doc soft-deleted.
    const deletedMsg = new Y.Map();
    deletedMsg.set("id", "pm-1");
    deletedMsg.set("kind", "space-deleted");
    deletedMsg.set("spaceId", SID);
    deletedMsg.set("spaceSnapshot", {
      id: SID,
      type: "document",
      name: "Doc",
      order: 0,
      locked: false,
      createdAt: 1000,
    });
    deletedMsg.set("createdAt", 1500);
    fakeMetaDoc.doc.getArray("projectMessages").push([deletedMsg]);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(restoreByNameMock).toHaveBeenCalledWith(
      spaceContentDocName(PID, SID, "document"),
    );
  });

  it("space:restore is idempotent against already-restored entries (skips them when finding latest deletion)", async () => {
    // Seed: a delete-restore cycle has already happened. The first
    // deleted entry is marked restored=true. A SECOND delete then
    // landed a fresh deleted entry. Restore should target the
    // second (unrestored) entry, leave the first one's
    // restored=true flag alone.
    const firstDeleted = new Y.Map();
    firstDeleted.set("id", "pm-1");
    firstDeleted.set("kind", "space-deleted");
    firstDeleted.set("spaceId", SID);
    firstDeleted.set("spaceSnapshot", {
      id: SID,
      type: "canvas",
      name: "First Cycle",
    });
    firstDeleted.set("createdAt", 1000);
    firstDeleted.set("restored", true);
    fakeMetaDoc.doc.getArray("projectMessages").push([firstDeleted]);

    const secondDeleted = new Y.Map();
    secondDeleted.set("id", "pm-2");
    secondDeleted.set("kind", "space-deleted");
    secondDeleted.set("spaceId", SID);
    secondDeleted.set("spaceSnapshot", {
      id: SID,
      type: "canvas",
      name: "Second Cycle",
    });
    secondDeleted.set("createdAt", 3000);
    fakeMetaDoc.doc.getArray("projectMessages").push([secondDeleted]);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    expect(secondDeleted.get("restored")).toBe(true);
    expect(firstDeleted.get("restored")).toBe(true); // unchanged
    // Restored snapshot is from the SECOND cycle (the latest unrestored one).
    const restored = fakeMetaDoc.doc.getMap("spaces").get(SID) as Y.Map<unknown>;
    expect(restored.get("name")).toBe("Second Cycle");
  });

  it("space:restore returns NOT_FOUND when no delete record exists", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("messages:clear all empties the array (owner)", async () => {
    const m1 = new Y.Map();
    m1.set("id", "pm-1");
    m1.set("kind", "missing-node");
    m1.set("createdAt", 1);
    fakeMetaDoc.doc.getArray("projectMessages").push([m1]);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "messages:clear", payload: { all: true } },
    );
    expect(res.ok).toBe(true);
    expect(fakeMetaDoc.doc.getArray("projectMessages").length).toBe(0);
  });
});
