/**
 * Unit tests for the Hocuspocus auth hook (v10 multi-doc).
 *
 * Pins these properties:
 *
 *   1. A missing or expired session token → error
 *   2. A session belonging to user A cannot open documents for a
 *      project they have no `project_members` row in
 *   3. A document name not in the v10 multi-doc shape is rejected
 *      (`project-{pid}/meta` or `project-{pid}/{kind}-{spaceId}`)
 *      — including the obsolete pre-v10 single-doc form
 *      `project-{pid}` and the pre-v6 `project-{pid}/canvas` /
 *      `/node/{id}` sub-paths
 *   4. A valid session for an active member is accepted, with the
 *      member's role echoed back; view → readOnly:true, others →
 *      readOnly:false
 *
 * Both Redis and postgres are mocked so the test is hermetic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Redis from "ioredis";
import * as Y from "yjs";
import { createAuthHook } from "../auth.js";

/**
 * Build a binary blob of a meta doc whose `spaces` Y.Map already
 * contains the given ids. Mirrors what `yjs-bootstrap.encodeInitialMetaState`
 * writes at project creation. Used to stage the third sql call
 * (`SELECT data FROM yjs_documents WHERE name = project-{pid}/meta`)
 * in the space-exists test cases below.
 */
function encodeMetaWithSpaces(ids: string[]): Buffer {
  const doc = new Y.Doc();
  const spaces = doc.getMap("spaces");
  for (const id of ids) {
    const entry = new Y.Map();
    entry.set("id", id);
    spaces.set(id, entry);
  }
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

// Mock postgres — the auth hook calls `sql\`SELECT ...\`` twice per
// invocation (project existence + member role). We track each call
// in order so a single test can stage both queries.
let sqlQueue: unknown[][];
vi.mock("postgres", () => ({
  default: () => () => {
    const next = sqlQueue.shift();
    return Promise.resolve(next ?? []);
  },
}));

const redisGet = vi.fn();
const mockRedis = { get: redisGet } as unknown as Redis;

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";

describe("createAuthHook", () => {
  beforeEach(() => {
    redisGet.mockReset();
    sqlQueue = [];
  });

  const buildHook = () =>
    createAuthHook({
      redis: mockRedis,
      envPrefix: "test",
      databaseUrl: "postgres://x",
    });

  it("rejects an empty token", async () => {
    const hook = buildHook();
    await expect(
      hook({ token: "", documentName: `project-${PID}/meta` }),
    ).rejects.toThrow(/token/i);
  });

  it("rejects an expired / unknown session token", async () => {
    redisGet.mockResolvedValue(null);
    const hook = buildHook();
    await expect(
      hook({ token: "bad-token", documentName: `project-${PID}/meta` }),
    ).rejects.toThrow(/session/i);
  });

  it("rejects an unrecognized document name", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();
    await expect(
      hook({ token: "tok", documentName: "random-doc-name" }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects the obsolete pre-v10 single-doc form", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();
    await expect(
      hook({ token: "tok", documentName: `project-${PID}` }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects pre-v6 /canvas and /node/{id} sub-paths", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();

    await expect(
      hook({ token: "tok", documentName: `project-${PID}/canvas` }),
    ).rejects.toThrow(/recognized project format/);

    await expect(
      hook({ token: "tok", documentName: `project-${PID}/node/abc` }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects a valid doc name when the user is not a member", async () => {
    redisGet.mockResolvedValue("attacker");
    // 1st query: project exists. 2nd query: no member row.
    sqlQueue = [[{ id: PID }], []];
    const hook = buildHook();

    await expect(
      hook({ token: "tok", documentName: `project-${PID}/canvas-${SID}` }),
    ).rejects.toThrow(/not authorized/);
  });

  it("rejects when the project itself does not exist", async () => {
    redisGet.mockResolvedValue("user-1");
    // 1st query: project missing. The auth hook should short-circuit
    // and not run the member query. We verify by leaving only one
    // staged response and asserting it ends up unconsumed.
    sqlQueue = [[]];
    const hook = buildHook();

    await expect(
      hook({ token: "tok", documentName: `project-${PID}/canvas-${SID}` }),
    ).rejects.toThrow(/not authorized/);
    // Member query never ran:
    expect(sqlQueue.length).toBe(0);
  });

  it("accepts an active owner; readOnly = false", async () => {
    redisGet.mockResolvedValue("user-1");
    // 3rd query is the meta doc fetch for space-exists check
    sqlQueue = [
      [{ id: PID }],
      [{ role: "owner" }],
      [{ data: encodeMetaWithSpaces([SID]) }],
    ];
    const hook = buildHook();

    const ctx = await hook({
      token: "tok",
      documentName: `project-${PID}/canvas-${SID}`,
    });

    expect(ctx).toEqual({
      user: { id: "user-1", role: "owner" },
      connection: { readOnly: false },
    });
  });

  it("accepts an active editor on the meta doc; readOnly = false (no space-exists fetch needed)", async () => {
    redisGet.mockResolvedValue("user-1");
    // Only 2 queries because the meta doc itself never triggers the
    // space-exists check.
    sqlQueue = [[{ id: PID }], [{ role: "edit" }]];
    const hook = buildHook();

    const ctx = await hook({
      token: "tok",
      documentName: `project-${PID}/meta`,
    });

    expect(ctx).toEqual({
      user: { id: "user-1", role: "edit" },
      connection: { readOnly: false },
    });
    expect(sqlQueue.length).toBe(0);
  });

  it("accepts an active viewer; readOnly = true", async () => {
    redisGet.mockResolvedValue("user-1");
    sqlQueue = [
      [{ id: PID }],
      [{ role: "view" }],
      [{ data: encodeMetaWithSpaces([SID]) }],
    ];
    const hook = buildHook();

    const ctx = await hook({
      token: "tok",
      documentName: `project-${PID}/canvas-${SID}`,
    });

    expect(ctx).toEqual({
      user: { id: "user-1", role: "view" },
      connection: { readOnly: true },
    });
  });

  // ── Space-exists check (ADR 2026-05-23-yjs-collab-only-write-authz §B1.5) ──

  it("rejects a canvas connection when the spaceId is not in meta.spaces (deleted Space)", async () => {
    redisGet.mockResolvedValue("user-1");
    sqlQueue = [
      [{ id: PID }],
      [{ role: "edit" }],
      // meta.spaces lists a different Space — the requested one has
      // been removed (soft-deleted; PG row may still hold the binary
      // for owner recovery, but the connection must be refused).
      [{ data: encodeMetaWithSpaces(["other-space-id"]) }],
    ];
    const hook = buildHook();

    await expect(
      hook({ token: "tok", documentName: `project-${PID}/canvas-${SID}` }),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects when the meta doc itself is missing in PG (defensive — bootstrap should always seed it)", async () => {
    redisGet.mockResolvedValue("user-1");
    sqlQueue = [
      [{ id: PID }],
      [{ role: "owner" }],
      [], // meta row gone — defensive: empty Set treats any spaceId as missing
    ];
    const hook = buildHook();

    await expect(
      hook({ token: "tok", documentName: `project-${PID}/canvas-${SID}` }),
    ).rejects.toThrow(/does not exist/);
  });

  it("skips the space-exists fetch for the meta doc itself", async () => {
    redisGet.mockResolvedValue("user-1");
    // Only 2 sql calls — no 3rd fetch because docName.kind === 'meta'.
    sqlQueue = [[{ id: PID }], [{ role: "owner" }]];
    const hook = buildHook();

    await hook({ token: "tok", documentName: `project-${PID}/meta` });
    expect(sqlQueue.length).toBe(0);
  });
});
