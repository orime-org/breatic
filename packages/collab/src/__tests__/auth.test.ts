// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for the Hocuspocus auth hook (v10 multi-doc).
 *
 * Pins these properties:
 *
 *   1. A missing or expired session cookie → error
 *   2. A session belonging to user A cannot open documents for a
 *      project they have no active role on
 *   3. A document name not in the v10 multi-doc shape is rejected
 *      (`project-{pid}/meta` or `project-{pid}/{kind}-{spaceId}`)
 *      — including the obsolete pre-v10 single-doc form
 *      `project-{pid}` and the pre-v6 `project-{pid}/canvas` /
 *      `/node/{id}` sub-paths
 *   4. A valid session for an active member is accepted, with the
 *      member's role echoed back, and the connection's read-only flag
 *      applied by MUTATING the passed-in `connectionConfig.readOnly`
 *      (viewer → true, others → false) — the property Hocuspocus reads
 *      when it builds the Connection. Returning `readOnly` in the hook's
 *      result does NOT work: that value lands in `context`, which
 *      Hocuspocus ignores for read-only enforcement.
 *
 * Auth is cookie-based since 2026-05-26: the Hocuspocus client sends
 * a placeholder `token` solely to trip the hook, and the real session
 * token travels in the `breatic_session` cookie on the WebSocket
 * upgrade request (Hocuspocus exposes the upgrade-request headers via
 * `requestHeaders`).
 *
 * Session + role resolution AND the Yjs space-existence read are all
 * delegated to `@breatic/core` (`getSession` +
 * `projectAuthService.loadProjectRole` + `yjsDocumentsRepo.fetchDocData`)
 * — the same shared kernel + single `yjs_documents` repo home the API
 * server uses, so the services cannot drift. All three are mocked here
 * so the test is hermetic; collab issues no raw SQL of its own.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "@breatic/core";
import * as Y from "yjs";

// `vi.hoisted` lifts these above the `vi.mock` factories (vitest hoists
// mock calls to the top of the file). The factories below close over
// them, so they must exist before any factory runs.
const {
  loggerWarn,
  loggerError,
  getSessionMock,
  loadProjectRoleMock,
  fetchDocDataMock,
} = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  getSessionMock: vi.fn(),
  loadProjectRoleMock: vi.fn(),
  fetchDocDataMock: vi.fn(),
}));

// `@breatic/core` is mocked wholesale (not spread-from-actual) because
// importing the real barrel pulls the `ai` SDK + opentelemetry
// transitive deps that vitest's ESM resolver chokes on. auth.ts uses
// exactly five exports — substitute each:
//   - getSession / loadProjectRole: the shared auth kernel, mocked
//   - createLogger: the unified core logger factory, mocked to expose
//     the warn/error spies the log-trail assertions below check
//   - yjsDocumentsRepo.fetchDocData: the single home for `yjs_documents`
//     SQL (the space-existence read), mocked to return a meta blob
//   - SESSION_COOKIE_NAME: the cookie name constant
vi.mock("@breatic/core", () => ({
  getSession: getSessionMock,
  projectAuthService: { loadProjectRole: loadProjectRoleMock },
  SESSION_COOKIE_NAME: "breatic_session",
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
// The yjs-store repo moved to collab; the auth hook now imports it
// locally. Mock the local repo (so its core `yjsDb` dependency never
// loads under test).
vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  fetchDocData: fetchDocDataMock,
}));

import { createAuthHook } from "../hooks/auth.js";

/** Helper — build the headers stub with `breatic_session={token}`. */
function withCookie(token: string): { cookie: string } {
  return { cookie: `breatic_session=${token}` };
}

/**
 * Build a binary blob of a meta doc whose `spaces` Y.Map already
 * contains the given ids. Mirrors what `yjs-bootstrap.encodeInitialMetaState`
 * writes at project creation. Used to stage the
 * `yjsDocumentsRepo.fetchDocData` return in the space-existence test
 * cases below.
 * @param ids - Space ids to seed into `meta.spaces`.
 * @returns The encoded meta-doc bytes.
 */
function encodeMetaWithSpaces(ids: string[]): Uint8Array {
  const doc = new Y.Doc();
  const spaces = doc.getMap("spaces");
  for (const id of ids) {
    const entry = new Y.Map();
    entry.set("id", id);
    spaces.set(id, entry);
  }
  return Y.encodeStateAsUpdate(doc);
}

const mockRedis = {} as unknown as Redis;

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const PLACEHOLDER_TOKEN = "__cookie_auth__";

describe("createAuthHook", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    loadProjectRoleMock.mockReset();
    fetchDocDataMock.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  // Wrap the real hook so tests may omit `connectionConfig` (Hocuspocus
  // always supplies one — defaulted to readOnly:false here). Tests asserting
  // the read-only side effect pass their OWN connectionConfig object and check
  // it was mutated. The production hook type keeps connectionConfig required,
  // so the protocol-level read-only contract stays enforced.
  const buildHook = (capacity?: {
    maxConnectionsPerDoc?: number;
    countConnections?: (documentName: string) => Promise<number>;
    registerConnection?: (documentName: string, socketId: string) => Promise<void>;
  }) => {
    const hook = createAuthHook({
      redis: mockRedis,
      maxConnectionsPerDoc: capacity?.maxConnectionsPerDoc ?? 100,
      countConnections: capacity?.countConnections ?? (async () => 0),
      registerConnection: capacity?.registerConnection ?? (async () => undefined),
    });
    type HookArgs = Parameters<typeof hook>[0];
    // Tests may omit `socketId` / `connectionConfig`; default both so
    // only cap / register tests that care need to supply them.
    return (
      args: Omit<HookArgs, "connectionConfig" | "socketId"> &
        Partial<Pick<HookArgs, "connectionConfig" | "socketId">>,
    ): ReturnType<typeof hook> =>
      hook({
        ...args,
        socketId: args.socketId ?? "socket-test",
        connectionConfig: args.connectionConfig ?? { readOnly: false },
      });
  };

  it("rejects when the session cookie is missing", async () => {
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/meta`,
        requestHeaders: {},
      }),
    ).rejects.toThrow(/cookie/i);
    expect(getSessionMock).not.toHaveBeenCalled();
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
    getSessionMock.mockResolvedValue(null);
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
    getSessionMock.mockResolvedValue("user-1");
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
    getSessionMock.mockResolvedValue("user-1");
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
    getSessionMock.mockResolvedValue("user-1");
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

  it("rejects a valid doc name when loadProjectRole returns null (not a member OR project gone)", async () => {
    getSessionMock.mockResolvedValue("attacker");
    // loadProjectRole collapses "no membership" and "project
    // missing/deleted" to the same null — the caller never learns
    // which, so cross-tenant existence probing is impossible.
    loadProjectRoleMock.mockResolvedValue(null);
    const hook = buildHook();

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/not authorized/);
    // Role lookup runs with the resolved userId + parsed projectId.
    expect(loadProjectRoleMock).toHaveBeenCalledWith("attacker", PID);
  });

  it("accepts an active owner; connection stays writable (readOnly = false)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    // The space-existence read is the only `yjs_documents` access the
    // hook makes — staged through the core repo mock.
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces([SID]));
    const hook = buildHook();
    // Hocuspocus passes a mutable connectionConfig (default readOnly:false).
    // The hook flips it as a SIDE EFFECT; Hocuspocus reads THIS — not the
    // hook's return value — when it builds the Connection.
    const connectionConfig = { readOnly: false };

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(ctx).toEqual({ user: { id: "user-1", role: "owner" } });
    expect(connectionConfig.readOnly).toBe(false);
  });

  it("accepts an active editor on the meta doc; connection stays writable (readOnly = false, no space-exists fetch needed)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook();
    const connectionConfig = { readOnly: false };

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(ctx).toEqual({ user: { id: "user-1", role: "editor" } });
    expect(connectionConfig.readOnly).toBe(false);
    // The meta doc never triggers the space-exists read.
    expect(fetchDocDataMock).not.toHaveBeenCalled();
  });

  // ── Connection cap (#1421 cross-instance) ──────────────────────────
  //
  // The cap applies to Space content docs only (meta is exempt). The
  // cluster-wide count does NOT include this connection — it is
  // registered AFTER the count + cap decision (so a connection never
  // counts against its own check, and a rejected one never counts at
  // all). Boundary is `>= cap`: the doc already holding `cap` connections
  // means this one is the extra and degrades. Capacity tests use a canvas
  // doc and stage the space-exists read (meta blob listing SID).

  it("degrades an at-capacity space doc to read-only even for an editor", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces([SID]));
    // The doc already holds 2 connections (this one excluded from the
    // count) and the cap is 2 → `2 >= 2` → degrade to read-only instead
    // of rejecting. The editor would otherwise be writable.
    const hook = buildHook({
      maxConnectionsPerDoc: 2,
      countConnections: async () => 2,
    });
    const connectionConfig = { readOnly: false };

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(connectionConfig.readOnly).toBe(true);
  });

  it("keeps an editor writable when the space doc is below its connection cap", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces([SID]));
    // The doc holds 1 connection (this one excluded); cap 2 → `1 >= 2` is
    // false → writable.
    const hook = buildHook({
      maxConnectionsPerDoc: 2,
      countConnections: async () => 1,
    });
    const connectionConfig = { readOnly: false };

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(connectionConfig.readOnly).toBe(false);
  });

  it("exempts the meta doc from the connection cap (project infrastructure — count never consulted, never registered)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    // Even far over cap, the meta doc is never degraded — everyone must
    // connect to it (#1421 decision). The cluster-wide count must not even
    // be consulted, and the meta connection is not registered.
    const countSpy = vi.fn(async () => 999);
    const registerSpy = vi.fn(async () => undefined);
    const hook = buildHook({
      maxConnectionsPerDoc: 2,
      countConnections: countSpy,
      registerConnection: registerSpy,
    });
    const connectionConfig = { readOnly: false };

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(connectionConfig.readOnly).toBe(false);
    expect(countSpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("skips the cluster-wide count for a viewer (already read-only, no wasted Redis round-trip) but still registers it", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("viewer");
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces([SID]));
    const countSpy = vi.fn(async () => 0);
    const registerSpy = vi.fn(async () => undefined);
    const hook = buildHook({
      maxConnectionsPerDoc: 2,
      countConnections: countSpy,
      registerConnection: registerSpy,
    });
    const connectionConfig = { readOnly: false };

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
      socketId: "sock-v",
    });

    // Viewer is read-only regardless, and the cap count is skipped — but a
    // viewer still holds a real slot, so it IS registered.
    expect(connectionConfig.readOnly).toBe(true);
    expect(countSpy).not.toHaveBeenCalled();
    expect(registerSpy).toHaveBeenCalledWith(`project-${PID}/canvas-${SID}`, "sock-v");
  });

  it("logs `connection_cap_degraded` warn when an editor drops to read-only at cap", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces([SID]));
    const hook = buildHook({
      maxConnectionsPerDoc: 2,
      countConnections: async () => 2,
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig: { readOnly: false },
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        projectId: PID,
        liveCount: 2,
        cap: 2,
        reason: "connection_cap_degraded",
      }),
      "connection_cap_degraded",
    );
  });

  // ── Registration timing (#1421): only AFTER every rejection check ────

  it("registers a connection (with its socketId) after a successful editor auth on a space doc", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces([SID]));
    const registerSpy = vi.fn(async () => undefined);
    const hook = buildHook({ registerConnection: registerSpy });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      socketId: "sock-42",
    });

    expect(registerSpy).toHaveBeenCalledWith(`project-${PID}/canvas-${SID}`, "sock-42");
  });

  it("does NOT register a rejected connection (not a member) — no leaked count", async () => {
    getSessionMock.mockResolvedValue("attacker");
    loadProjectRoleMock.mockResolvedValue(null);
    const registerSpy = vi.fn(async () => undefined);
    const hook = buildHook({ registerConnection: registerSpy });

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
        socketId: "sock-x",
      }),
    ).rejects.toThrow(/not authorized/);

    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("does NOT register a connection to a deleted space (space-exists reject)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces(["other-space-id"]));
    const registerSpy = vi.fn(async () => undefined);
    const hook = buildHook({ registerConnection: registerSpy });

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
        socketId: "sock-y",
      }),
    ).rejects.toThrow(/does not exist/);

    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("accepts an active viewer; connection forced read-only (connectionConfig.readOnly mutated — the property Hocuspocus enforces)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("viewer");
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces([SID]));
    const hook = buildHook();
    const connectionConfig = { readOnly: false };

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(ctx).toEqual({ user: { id: "user-1", role: "viewer" } });
    // SECURITY INVARIANT (root-caused 2026-06-18). The hook MUST mutate
    // connectionConfig.readOnly: Hocuspocus reads THIS when constructing
    // the Connection and rejects every incoming sync-update on a read-only
    // connection (hocuspocus-server messageYjsUpdate / syncStep2 handlers).
    // The prior bug returned `{ connection: { readOnly } }`, which only
    // populated `context` — a value Hocuspocus never reads — so viewers
    // could drag canvas nodes + tamper meta.projectMeta via raw Yjs.
    expect(connectionConfig.readOnly).toBe(true);
  });

  // ── Space-exists check (ADR 2026-05-23-yjs-collab-only-write-authz §B1.5) ──

  it("rejects a canvas connection when the spaceId is not in meta.spaces (deleted Space)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    // meta.spaces lists a different Space — the requested one has been
    // removed (soft-deleted; PG row may still hold the binary for owner
    // recovery, but the connection must be refused).
    fetchDocDataMock.mockResolvedValue(encodeMetaWithSpaces(["other-space-id"]));
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
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    fetchDocDataMock.mockResolvedValue(null); // meta row gone — empty Set treats any spaceId as missing
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
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    const hook = buildHook();

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
      connectionConfig: { readOnly: false },
    });
    expect(fetchDocDataMock).not.toHaveBeenCalled();
  });

  // ── Cookie parser robustness ───────────────────────────────────

  it("parses the session value when other cookies appear before it", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    const hook = buildHook();

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: {
        cookie: "first=1; breatic_session=real-token; third=3",
      },
      connectionConfig: { readOnly: false },
    });

    expect(ctx.user.id).toBe("user-1");
    // The session store is queried with the *real* cookie value, not
    // the placeholder application-level token — pins that the cookie
    // value is what reaches core's getSession.
    expect(getSessionMock).toHaveBeenCalledWith(mockRedis, "real-token");
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
    getSessionMock.mockResolvedValue(null);
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
    getSessionMock.mockResolvedValue("attacker");
    loadProjectRoleMock.mockResolvedValue(null);
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

  it("logs `auth_unexpected_error` error when getSession throws (infrastructure failure path)", async () => {
    // Simulate the ioredis long-running drift mode that motivated
    // this whole hardening — getSession throws something that ISN'T a
    // known auth-policy reject. The catch should classify it as
    // `auth_unexpected_error` with the `err` object attached so
    // oncall sees the underlying error, not just "Unauthorized".
    getSessionMock.mockRejectedValue(new Error("Connection is closed."));
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
