/**
 * Unit tests for the Hocuspocus auth hook (v10 multi-doc).
 *
 * Pins these properties:
 *
 *   1. A missing or expired session cookie → error
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
 * Auth is cookie-based since 2026-05-26: the Hocuspocus client sends
 * a placeholder `token` solely to trip the hook, and the real session
 * token travels in the `breatic_session` cookie on the WebSocket
 * upgrade request (Hocuspocus exposes the upgrade-request headers via
 * `requestHeaders`).
 *
 * Both Redis and postgres are mocked so the test is hermetic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Redis from "ioredis";
import type { IncomingHttpHeaders } from "node:http";
import * as Y from "yjs";

// Mock the collab logger BEFORE importing auth so the auth module's
// `createLogger('auth')` returns this stub. The mandate is that
// every onAuthenticate decision (accept or reject) leaves a
// structured server-side log line — tests below assert the warn /
// error calls land with the expected `reason` tag, otherwise the
// 3am-oncall trail we just added to auth.ts would silently rot
// the next time someone refactors.
//
// `vi.hoisted` is required here because `vi.mock` factories run
// before any top-level `const` declarations (vitest hoists them to
// the top of the file). Without `vi.hoisted` the closure-captured
// `loggerWarn` would be in the TDZ when the mock factory fires.
const { loggerWarn, loggerError } = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createAuthHook } from "../auth.js";

/** Helper — build the headers stub with `breatic_session={token}`. */
function withCookie(token: string): IncomingHttpHeaders {
  return { cookie: `breatic_session=${token}` };
}

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
const PLACEHOLDER_TOKEN = "__cookie_auth__";

describe("createAuthHook", () => {
  beforeEach(() => {
    redisGet.mockReset();
    sqlQueue = [];
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  const buildHook = () =>
    createAuthHook({
      redis: mockRedis,
      envPrefix: "test",
      databaseUrl: "postgres://x",
    });

  it("rejects when the session cookie is missing", async () => {
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/meta`,
        requestHeaders: {},
      }),
    ).rejects.toThrow(/cookie/i);
  });

  it("rejects when the cookie header is present but `breatic_session=` is not", async () => {
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/meta`,
        requestHeaders: { cookie: "other_app=xyz" },
      }),
    ).rejects.toThrow(/cookie/i);
  });

  it("rejects an expired / unknown session token", async () => {
    redisGet.mockResolvedValue(null);
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/meta`,
        requestHeaders: withCookie("bad-token"),
      }),
    ).rejects.toThrow(/session/i);
  });

  it("rejects an unrecognized document name", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: "random-doc-name",
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects the obsolete pre-v10 single-doc form", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects pre-v6 /canvas and /node/{id} sub-paths", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/recognized project format/);

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/node/abc`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects a valid doc name when the user is not a member", async () => {
    redisGet.mockResolvedValue("attacker");
    // 1st query: project exists. 2nd query: no member row.
    sqlQueue = [[{ id: PID }], []];
    const hook = buildHook();

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
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
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
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
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
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
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
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
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
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
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
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
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("skips the space-exists fetch for the meta doc itself", async () => {
    redisGet.mockResolvedValue("user-1");
    // Only 2 sql calls — no 3rd fetch because docName.kind === 'meta'.
    sqlQueue = [[{ id: PID }], [{ role: "owner" }]];
    const hook = buildHook();

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
    });
    expect(sqlQueue.length).toBe(0);
  });

  // ── Cookie parser robustness ───────────────────────────────────

  it("parses the session value when other cookies appear before it", async () => {
    redisGet.mockResolvedValue("user-1");
    sqlQueue = [[{ id: PID }], [{ role: "owner" }]];
    const hook = buildHook();

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: {
        cookie: "first=1; breatic_session=real-token; third=3",
      },
    });

    expect(ctx.user.id).toBe("user-1");
    // Redis was queried for the prefixed key with the *real* token,
    // not the placeholder — pins that the cookie value (not the
    // application-level token field) is what reaches the session
    // store.
    expect(redisGet).toHaveBeenCalledWith("test:session:real-token");
  });

  // ── Server-side log trail (CLAUDE.md 服务器端工业级标准 mandate) ──
  //
  // Every onAuthenticate rejection must leave a structured warn line
  // tagged `auth_rejected` with a machine-grep-able `reason`, so a
  // 3am oncall can split "policy reject" trends without re-parsing
  // free-text. Infrastructure failures (Redis ping fail / pg
  // connection drop) bypass the known-reason walk and land in the
  // outer catch as `auth_unexpected_error` so dashboards can tell
  // them apart.

  it("logs `auth_rejected` warn with reason=missing_cookie when cookie is absent", async () => {
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/meta`,
        requestHeaders: {},
      }),
    ).rejects.toThrow(/cookie/i);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "missing_cookie" }),
      "auth_rejected",
    );
  });

  it("logs `auth_rejected` warn with reason=session_not_found for expired tokens", async () => {
    redisGet.mockResolvedValue(null);
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/meta`,
        requestHeaders: withCookie("bad-token"),
      }),
    ).rejects.toThrow(/session/i);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "session_not_found" }),
      "auth_rejected",
    );
  });

  it("logs `auth_rejected` warn with reason=not_member for a stranger", async () => {
    redisGet.mockResolvedValue("attacker");
    sqlQueue = [[{ id: PID }], []];
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/not authorized/);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "attacker",
        projectId: PID,
        reason: "not_member",
      }),
      "auth_rejected",
    );
  });

  it("logs `auth_unexpected_error` error when Redis throws (infrastructure failure path)", async () => {
    // Simulate the ioredis long-running drift mode that motivated
    // this whole branch — redis.get throws something that ISN'T a
    // known auth-policy reject. The catch should classify it as
    // `auth_unexpected_error` with the `err` object attached so
    // oncall sees the underlying Redis error, not just "Unauthorized".
    redisGet.mockRejectedValue(
      new Error("Connection is closed."),
    );
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/meta`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/Connection is closed/);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: "Connection is closed." }),
        documentName: `project-${PID}/meta`,
      }),
      "auth_unexpected_error",
    );
  });
});
