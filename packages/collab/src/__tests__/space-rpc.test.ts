/**
 * Smoke tests for collab space-rpc handlers.
 *
 * Pins the role-validation matrix + dispatch routing + basic
 * happy/error response shapes. Full Yjs-mutation behavior is covered
 * by the integration smoke run in PR-b (where the frontend wires
 * onto these RPCs end-to-end with a real collab + PG).
 *
 * Mock surface:
 *   - hocuspocus.openDirectConnection — returns a fake DirectConnection
 *     whose `transact(fn)` runs `fn` against a backing Y.Doc that the
 *     test inspects after the handler returns.
 *   - sql — a vi.fn() tagged template stub (returns []) so SQL writes
 *     (canvas row soft-delete / restore) don't crash.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import type postgres from "postgres";

import { handleSpaceRpc } from "../space-rpc.js";

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

// sql is a tagged template — calling it returns a Promise<rows>.
function makeSql(): ReturnType<typeof postgres> {
  return vi.fn(async () => []) as unknown as ReturnType<typeof postgres>;
}

beforeEach(() => {
  fakeMetaDoc = {
    doc: new Y.Doc(),
    disconnect: vi.fn(async () => {}),
  };
});

describe("handleSpaceRpc — role validation", () => {
  it("space:create refuses view role", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u", role: "view" },
      {
        id: "r1",
        type: "space:create",
        payload: { spaceId: SID, type: "canvas", name: "Main" },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
  });

  it("space:delete refuses view role", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u", role: "view" },
      { id: "r1", type: "space:delete", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
  });

  it("space:lock refuses view role", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u", role: "view" },
      {
        id: "r1",
        type: "space:lock",
        payload: { spaceId: SID, locked: true },
      },
    );
    expect(res.ok).toBe(false);
  });

  it("space:restore refuses edit role (owner-only)", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u", role: "edit" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
  });

  it("messages:clear refuses edit role (owner-only)", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u", role: "edit" },
      { id: "r1", type: "messages:clear", payload: { all: true } },
    );
    expect(res.ok).toBe(false);
  });
});

describe("handleSpaceRpc — happy paths", () => {
  it("space:create writes meta.spaces + pushes projectMessages", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u-1", role: "edit" },
      {
        id: "r1",
        type: "space:create",
        payload: { spaceId: SID, type: "canvas", name: "Main" },
      },
    );
    expect(res.ok).toBe(true);
    const spaces = fakeMetaDoc.doc.getMap("spaces");
    expect(spaces.has(SID)).toBe(true);
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
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u-1", role: "edit" },
      {
        id: "r1",
        type: "space:create",
        payload: { spaceId: SID, type: "canvas", name: "Duplicate" },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
  });

  it("space:delete removes meta.spaces entry + pushes 'space-deleted' with snapshot", async () => {
    const existing = new Y.Map();
    existing.set("id", SID);
    existing.set("type", "canvas");
    existing.set("name", "Main");
    existing.set("locked", false);
    existing.set("order", 0);
    fakeMetaDoc.doc.getMap("spaces").set(SID, existing);

    const sql = makeSql();
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql },
      PID,
      { userId: "u-1", role: "edit" },
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
    expect(sql).toHaveBeenCalled(); // soft-delete canvas row
  });

  it("space:delete returns NOT_FOUND when spaceId is absent", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u-1", role: "edit" },
      { id: "r1", type: "space:delete", payload: { spaceId: "missing" } },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("space:lock toggles entry.locked + pushes correct kind", async () => {
    const existing = new Y.Map();
    existing.set("id", SID);
    existing.set("name", "Main");
    existing.set("locked", false);
    fakeMetaDoc.doc.getMap("spaces").set(SID, existing);

    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u-1", role: "edit" },
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
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u-1", role: "edit" },
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
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u-1", role: "edit" },
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
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "u-1", role: "edit" },
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

  it("space:restore rebuilds entry from latest space-deleted snapshot (owner)", async () => {
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

    const sql = makeSql();
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "space:restore", payload: { spaceId: SID } },
    );
    expect(res.ok).toBe(true);
    const restored = fakeMetaDoc.doc.getMap("spaces").get(SID) as Y.Map<unknown>;
    expect(restored.get("name")).toBe("Restored Me");
    expect(sql).toHaveBeenCalled(); // un-soft-delete canvas row
    // and a space-restored projectMessage was pushed
    expect(fakeMetaDoc.doc.getArray("projectMessages").length).toBe(2);
  });

  it("space:restore returns NOT_FOUND when no delete record exists", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
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
      { hocuspocus: makeHocuspocus(), sql: makeSql() },
      PID,
      { userId: "owner-1", role: "owner" },
      { id: "r1", type: "messages:clear", payload: { all: true } },
    );
    expect(res.ok).toBe(true);
    expect(fakeMetaDoc.doc.getArray("projectMessages").length).toBe(0);
  });
});

describe("handleSpaceRpc — users:upsert-self", () => {
  it("writes meta.users[caller.userId] with name + avatarUrl + updatedAt", async () => {
    const res = await handleSpaceRpc(
      {
        hocuspocus: makeHocuspocus(),
        sql: makeSql(),
        metaDoc: fakeMetaDoc.doc,
      },
      PID,
      { userId: "u-yuki", role: "edit", name: "Yuki" },
      {
        id: "r1",
        type: "users:upsert-self",
        payload: {
          // Client-supplied name is INTENTIONALLY different from
          // caller.name — handler must ignore the payload's name and
          // use caller.name (the authoritative value from PG).
          name: "Spoofed",
          avatarUrl: "https://cdn.example.com/yuki.png",
        },
      },
    );
    expect(res.ok).toBe(true);
    const entry = fakeMetaDoc.doc.getMap("users").get("u-yuki") as Y.Map<unknown>;
    expect(entry).toBeInstanceOf(Y.Map);
    expect(entry.get("name")).toBe("Yuki"); // authoritative, NOT "Spoofed"
    expect(entry.get("avatarUrl")).toBe("https://cdn.example.com/yuki.png");
    expect(typeof entry.get("updatedAt")).toBe("number");
  });

  it("is idempotent — no transact when name + avatarUrl unchanged", async () => {
    // Seed an existing entry that already matches.
    const seeded = new Y.Map<unknown>();
    seeded.set("id", "u-yuki");
    seeded.set("name", "Yuki");
    seeded.set("avatarUrl", null);
    seeded.set("updatedAt", 1000);
    fakeMetaDoc.doc.getMap("users").set("u-yuki", seeded);

    const res = await handleSpaceRpc(
      {
        hocuspocus: makeHocuspocus(),
        sql: makeSql(),
        metaDoc: fakeMetaDoc.doc,
      },
      PID,
      { userId: "u-yuki", role: "edit", name: "Yuki" },
      {
        id: "r2",
        type: "users:upsert-self",
        payload: { name: "Yuki", avatarUrl: null },
      },
    );
    expect(res.ok).toBe(true);
    const entry = fakeMetaDoc.doc.getMap("users").get("u-yuki") as Y.Map<unknown>;
    expect(entry.get("updatedAt")).toBe(1000); // unchanged — skipped
  });

  it("updates existing entry in place when name changes", async () => {
    const seeded = new Y.Map<unknown>();
    seeded.set("id", "u-yuki");
    seeded.set("name", "Yuki Old");
    seeded.set("avatarUrl", null);
    seeded.set("updatedAt", 1000);
    fakeMetaDoc.doc.getMap("users").set("u-yuki", seeded);

    const res = await handleSpaceRpc(
      {
        hocuspocus: makeHocuspocus(),
        sql: makeSql(),
        metaDoc: fakeMetaDoc.doc,
      },
      PID,
      { userId: "u-yuki", role: "edit", name: "Yuki New" },
      {
        id: "r3",
        type: "users:upsert-self",
        payload: { name: "Yuki New", avatarUrl: null },
      },
    );
    expect(res.ok).toBe(true);
    // Same Y.Map reference — Yjs CRDT prefers in-place mutation over replace.
    const entry = fakeMetaDoc.doc.getMap("users").get("u-yuki") as Y.Map<unknown>;
    expect(entry).toBe(seeded);
    expect(entry.get("name")).toBe("Yuki New");
    expect((entry.get("updatedAt") as number) > 1000).toBe(true);
  });

  it("returns INTERNAL when caller.name is missing (auth hook drift)", async () => {
    const res = await handleSpaceRpc(
      {
        hocuspocus: makeHocuspocus(),
        sql: makeSql(),
        metaDoc: fakeMetaDoc.doc,
      },
      PID,
      { userId: "u-1", role: "edit" }, // no name
      {
        id: "r4",
        type: "users:upsert-self",
        payload: { name: "Whatever", avatarUrl: null },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INTERNAL");
    expect(fakeMetaDoc.doc.getMap("users").size).toBe(0);
  });

  it("returns INTERNAL when metaDoc is missing from context (dispatcher drift)", async () => {
    const res = await handleSpaceRpc(
      { hocuspocus: makeHocuspocus(), sql: makeSql() }, // no metaDoc
      PID,
      { userId: "u-1", role: "edit", name: "Yuki" },
      {
        id: "r5",
        type: "users:upsert-self",
        payload: { name: "Yuki", avatarUrl: null },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INTERNAL");
  });
});
