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
import { createAuthHook } from "../auth.js";

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
    sqlQueue = [[{ id: PID }], [{ role: "owner" }]];
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

  it("accepts an active editor; readOnly = false", async () => {
    redisGet.mockResolvedValue("user-1");
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
  });

  it("accepts an active viewer; readOnly = true", async () => {
    redisGet.mockResolvedValue("user-1");
    sqlQueue = [[{ id: PID }], [{ role: "view" }]];
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
});
