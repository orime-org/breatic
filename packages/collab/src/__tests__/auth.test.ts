// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * token travels in the httpOnly session cookie on the WebSocket
 * upgrade request (Hocuspocus exposes the upgrade-request headers via
 * `requestHeaders`). The name is deployment-scoped in production
 * (`sessionCookieName()`, #1831); the core mock below pins it to the
 * bare `breatic_session` so these fixtures stay independent of env.
 *
 * Session and role resolution are delegated to `@breatic/core`
 * (`getSession` + `projectAuthService.loadProjectRole`) — the same shared
 * kernel the API server uses, so the two cannot drift. The Yjs
 * space-existence check answers from the meta doc this process holds
 * (staged here as a plain Map) and, when it holds none, loads one through
 * `createDocument` (staged here as a spy). Both are under the test's
 * control, so the test is hermetic and no database is ever reached; the
 * hook itself no longer touches `yjs_documents` at all (#26).
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type * as CoreModule from "@breatic/core";
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
} = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  getSessionMock: vi.fn(),
  loadProjectRoleMock: vi.fn(),
}));

// `@breatic/core` is replaced wholesale so every export auth.ts touches is
// under the test's control and no real session store or database connection
// is ever opened. auth.ts uses exactly four of them — substitute each:
//   - getSession / loadProjectRole: the shared auth kernel, mocked
//   - createLogger: the unified core logger factory, mocked to expose
//     the warn/error spies the log-trail assertions below check
//   - sessionCookieName(): the per-deployment cookie name
vi.mock("@breatic/core", async (importOriginal) => ({
  listedContentDocNames: (await importOriginal<typeof CoreModule>()).listedContentDocNames,
  sessionId: (await importOriginal<typeof CoreModule>()).sessionId,
  env: { ALLOWED_ORIGINS: "https://app.example.com" },
  getSession: getSessionMock,
  projectAuthService: { loadProjectRole: loadProjectRoleMock },
  sessionCookieName: () => "breatic_session",
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
import { createAuthHook, type CreateAuthHookOptions } from "../hooks/auth.js";
import { shouldTrackConnection } from "@collab/services/connection-tracking.js";

/** Helper — build the headers stub with `breatic_session={token}`. */
function withCookie(token: string): Headers {
  return new Headers({ cookie: `breatic_session=${token}` });
}

/**
 * Stand-in for the table of in-memory documents Hocuspocus hands the hook.
 * A plain `Map` is the usual one; a case that needs to see WHETHER the table
 * was consulted passes {@link watchedDocuments} instead.
 */
type LoadedDocumentsStub = { get(documentName: string): Y.Doc | undefined };

/**
 * A documents table that records every lookup, for the cases whose subject is
 * whether the in-memory route was taken at all rather than what it answered.
 * @param entries - Documents the table holds, keyed by document name.
 * @returns The table plus the spy standing in for its `get`.
 */
function watchedDocuments(entries: ReadonlyArray<[string, Y.Doc]>): {
  documents: LoadedDocumentsStub;
  get: ReturnType<typeof vi.fn>;
} {
  const backing = new Map(entries);
  const get = vi.fn((name: string) => backing.get(name));
  return { documents: { get }, get };
}

/**
 * Build a live meta doc — the in-memory object Hocuspocus keeps in
 * `instance.documents`, as opposed to the encoded bytes Postgres stores.
 * Used to stage the in-memory route of the space-existence check.
 * @param ids - Space ids to place in `meta.spaces`; {@link DOC_SID} is a
 *   document Space, every other id a canvas Space.
 * @returns The meta `Y.Doc`.
 */
function liveMetaWithSpaces(ids: string[]): Y.Doc {
  const doc = new Y.Doc();
  const spaces = doc.getMap("spaces");
  for (const id of ids) {
    const entry = new Y.Map();
    spaces.set(id, entry);
    entry.set("id", id);
    entry.set("type", id === DOC_SID ? "document" : "canvas");
  }
  return doc;
}

const mockRedis = {} as unknown as Redis;

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const DOC_SID = "33333333-3333-4333-9333-333333333333";
const PLACEHOLDER_TOKEN = "__cookie_auth__";

describe("createAuthHook", () => {
  /** Records every load the check asks for, and every one it puts back. */
  const createDocumentSpy = vi.fn();
  const unloadDocumentSpy = vi.fn(async () => undefined);

  beforeEach(() => {
    createDocumentSpy.mockReset();
    unloadDocumentSpy.mockReset();
    unloadDocumentSpy.mockResolvedValue(undefined);
    getSessionMock.mockReset();
    loadProjectRoleMock.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  // Wrap the real hook so tests may omit `connectionConfig` (Hocuspocus
  // always supplies one — defaulted to readOnly:false here). Tests asserting
  // the read-only side effect pass their OWN connectionConfig object and check
  // it was mutated. The production hook type keeps connectionConfig required,
  // so the protocol-level read-only contract stays enforced.
  const buildHook = (overrides?: {
    /**
     * The per-document ceiling. A number is the common case and is wrapped
     * into a resolver; pass a function to exercise what happens when
     * resolving the tier fails, or to assert which project was asked about.
     *
     * It is a resolver rather than a constant because the ceiling now comes
     * from the tier of the studio that owns the project (#88), so it is
     * per-project and only knowable at handshake time.
     */
    connectionLimit?: number | ((projectId: string) => Promise<number>);
    countConnections?: (documentName: string) => Promise<number>;
    /**
     * Whether this person already holds a seat on this document, cluster-wide.
     * `yes` lets a full document's handshake stay writable (the seat is
     * replaced atomically later, in `connected`), `unknown` (Redis could not
     * say) does too, `no` settles for read-only. Defaults to `no`, so a case
     * that says nothing about it holds no seat.
     */
    hasOwnSeat?: (
      documentName: string,
      userId: string,
    ) => Promise<"yes" | "no" | "unknown">;
    /**
     * Documents this process already holds, keyed by document name — the
     * table Hocuspocus hands the hook as `instance.documents`. Empty by
     * default, so a case that says nothing about it exercises the load.
     */
    documents?: LoadedDocumentsStub;
    /**
     * What a load produces, keyed by document name. Stands in for the
     * persistence extension plus the peer sync; a name that is absent loads
     * as an empty document, which is what the framework does.
     */
    loadable?: Map<string, Y.Doc>;
  }) => {
    const limit = overrides?.connectionLimit ?? 100;
    const hook = createAuthHook({
      redis: mockRedis,
      resolveConnectionLimit:
        typeof limit === "function" ? limit : async () => limit,
      countConnections: overrides?.countConnections ?? (async () => 0),
      hasOwnSeat: overrides?.hasOwnSeat ?? (async () => "no" as const),
    });
    type HookArgs = Parameters<typeof hook>[0];
    // Default: this process already holds the project's list, and it has the
    // Space these fixtures use. That is the precondition the pre-existing
    // content-doc cases staged through the storage read before #26 — the
    // subject of those cases is roles and caps, not existence.
    const documents =
      overrides?.documents ??
      new Map<string, Y.Doc>([
        [`project-${PID}/meta`, liveMetaWithSpaces([SID, DOC_SID])],
      ]);
    const loadable = overrides?.loadable ?? new Map<string, Y.Doc>();
    const registry = {
      documents,
      createDocument: createDocumentSpy.mockImplementation(
        async (documentName: string) =>
          loadable.get(documentName) ?? new Y.Doc(),
      ),
      unloadDocument: unloadDocumentSpy,
    };
    // Tests may omit `connectionConfig`; default it so only cap tests that
    // assert the read-only side effect need to supply their own.
    return (
      args: Omit<
        HookArgs,
        "connectionConfig" | "instance" | "request" | "socketId"
      > &
        Partial<Pick<HookArgs, "connectionConfig">>,
    ): ReturnType<typeof hook> =>
      hook({
        ...args,
        connectionConfig: args.connectionConfig ?? { readOnly: false },
        instance: registry,
        request: new Request("http://localhost/"),
        socketId: "socket-1",
      });
  };

  it("rejects an untrusted browser origin before looking up a session", async () => {
    const hook = buildHook();
    await expect(hook({token: PLACEHOLDER_TOKEN, documentName: `project-${PID}/meta`,
      requestHeaders: new Headers({origin: "https://untrusted.example",cookie: "breatic_session=tok"}),
    })).rejects.toThrow("Origin not allowed");
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("allows a trusted browser origin to reach session authentication", async () => {
    const hook = buildHook();
    getSessionMock.mockResolvedValue(null);
    await expect(hook({token: PLACEHOLDER_TOKEN, documentName: `project-${PID}/meta`,
      requestHeaders: new Headers({origin: "https://app.example.com",cookie: "breatic_session=tok"}),
    })).rejects.toThrow("Invalid or expired session token");
    expect(getSessionMock).toHaveBeenCalled();
  });

  it("rejects when the session cookie is missing", async () => {
    const hook = buildHook();
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/meta`,
        requestHeaders: new Headers(),
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
        requestHeaders: new Headers({ cookie: "other_app=xyz" }),
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
    // Existence is staged by `buildHook`'s default `documents` map; the hook
    // makes no `yjs_documents` access at all (#26).
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

    expect(ctx).toEqual({
      user: { id: "user-1", role: "owner" },
      // Writable on a content doc under the default ceiling of 100.
      seatCap: 100,
      arrivedAtMs: expect.any(Number),
      session: { token: "tok", id: createHash("sha256").update("tok").digest("hex") },
    });
    expect(connectionConfig.readOnly).toBe(false);
  });

  // ── Task #27: the meta doc is read-only for every client ──────────────
  //
  // The meta doc is the project's directory — which Spaces exist, who the
  // members are, which tabs each person has open. Changing any of it has
  // rules attached (a role to check, a content row to create, a ledger
  // entry, "you cannot delete the last Space"), and rules a client can
  // choose not to run are not rules. So every change goes through an RPC
  // and the client's own connection to that doc cannot write at all.
  //
  // This replaces a hand-written gate that inspected each frame to see
  // which field it touched. That gate had to enumerate the framework's
  // internal message types to recognise a write, and it failed open on
  // every type it missed — it never ran on a real frame for its whole
  // life. Read-only is enforced by the framework at each write site, so
  // there is no list to keep in sync and nothing to miss.
  //
  // Content docs are untouched: a canvas or a document body is the user's
  // own work, it has no rules to enforce, and it stays writable by role.

  it("makes the meta doc read-only for an editor", async () => {
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

    expect(ctx).toEqual({
      user: { id: "user-1", role: "editor" },
      seatCap: null,
      arrivedAtMs: expect.any(Number),
      session: { token: "tok", id: createHash("sha256").update("tok").digest("hex") },
    });
    expect(connectionConfig.readOnly).toBe(true);
    // The meta doc never triggers the space-exists read.
  });

  it("makes the meta doc read-only for an owner too", async () => {
    // Not a permission level — nobody writes the directory directly,
    // however senior. An owner's extra powers are exercised through the
    // RPCs, which run on the server side of the same connection.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    const hook = buildHook();
    const connectionConfig = { readOnly: false };

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(connectionConfig.readOnly).toBe(true);
  });

  it("leaves a content doc writable for an editor", async () => {
    // The regression guard for the change above: making meta read-only
    // must not touch the docs people actually create in.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook();
    const connectionConfig = { readOnly: false };

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${DOC_SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(connectionConfig.readOnly).toBe(false);
  });

  // ── Connection cap (#1421 cross-instance) ──────────────────────────
  //
  // The cap applies to Space content docs only (meta is exempt). The
  // cluster-wide count does NOT include this connection — it is
  // registered AFTER the count + cap decision (so a connection never
  // counts against its own check, and a rejected one never counts at
  // all). Boundary is `>= cap`: the doc already holding `cap` connections
  // means this one is the extra and degrades. Capacity tests use a canvas
  // doc; existence is staged by `buildHook`'s default in-memory meta doc,
  // which lists SID.

  it("degrades an at-capacity space doc to read-only even for an editor", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    // The doc already holds 2 connections (this one excluded from the
    // count) and the cap is 2 → `2 >= 2` → degrade to read-only instead
    // of rejecting. The editor would otherwise be writable.
    const hook = buildHook({
      connectionLimit: 2,
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
    // The doc holds 1 connection (this one excluded); cap 2 → `1 >= 2` is
    // false → writable.
    const hook = buildHook({
      connectionLimit: 2,
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

  it("exempts the meta doc from the connection cap (project infrastructure — count never consulted)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    // Even far over cap, the meta doc is never degraded — everyone must
    // connect to it (#1421 decision). The cluster-wide count must not even
    // be consulted for meta.
    const countSpy = vi.fn(async () => 999);
    const hook = buildHook({ connectionLimit: 2, countConnections: countSpy });
    const connectionConfig = { readOnly: false };

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    // Deliberately no assertion on readOnly here. The meta doc IS
    // read-only, but for an unrelated reason (task #27 — clients never
    // write the directory), and asserting it in this case would make a
    // cap test fail whenever that other rule changes. What this case is
    // about is that the cluster-wide count is never consulted for meta,
    // which the spy states directly.
    expect(countSpy).not.toHaveBeenCalled();
  });

  // ── Asking whether the arriving person already holds a seat (inner#1034) ──
  //
  // At capacity, before settling for read-only, the handshake asks whether
  // the arriving person ALREADY holds a seat here. If they do, this connection
  // is let in writable: the seat itself is replaced atomically by the script
  // the `connected` hook runs, so nobody is ever kept out by themselves, and
  // nothing is taken here — the framework can still abandon this connection
  // before `connected`. The handshake hands `connected` the ceiling it judged
  // by (`seatCap`, null when this connection takes no seat) and the moment it
  // started (`arrivedAtMs`), which orders this person's connections.

  const CANVAS_DOC = `project-${PID}/canvas-${SID}`;

  /**
   * Run the hook once on a content doc as an editor with a ceiling of 2.
   * @param options - What the cap lookups answer.
   * @param options.count - The cluster-wide count.
   * @param options.own - What `hasOwnSeat` answers.
   * @param options.role - The member's role.
   * @param options.documentName - The document.
   * @param options.limit - The ceiling, or a resolver.
   * @returns The context, the settled config and the three spies.
   */
  async function capCase(options: {
    count: number;
    own?: "yes" | "no" | "unknown";
    role?: string;
    documentName?: string;
    limit?: number | ((projectId: string) => Promise<number>);
  }): Promise<{
    ctx: Record<string, unknown>;
    connectionConfig: { readOnly: boolean };
    resolveSpy: ReturnType<typeof vi.fn>;
    countSpy: ReturnType<typeof vi.fn>;
    ownSpy: ReturnType<typeof vi.fn>;
  }> {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue(options.role ?? "editor");
    const limit = options.limit ?? 2;
    const resolveSpy = vi.fn(async (projectId: string): Promise<number> =>
      typeof limit === "function" ? limit(projectId) : limit,
    );
    const countSpy = vi.fn(async () => options.count);
    const ownSpy = vi.fn(async () => options.own ?? ("no" as const));
    const hook = buildHook({ connectionLimit: resolveSpy, countConnections: countSpy, hasOwnSeat: ownSpy });
    const connectionConfig = { readOnly: false };
    const ctx = (await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: options.documentName ?? CANVAS_DOC,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    })) as unknown as Record<string, unknown>;
    return { ctx, connectionConfig, resolveSpy, countSpy, ownSpy };
  }

  it("E-A01 hands a writable connection below the cap its ceiling, without asking about own seats", async () => {
    const { ctx, connectionConfig, ownSpy } = await capCase({ count: 1 });
    expect(connectionConfig.readOnly).toBe(false);
    expect(ctx.seatCap).toBe(2);
    expect(ownSpy).not.toHaveBeenCalled();
    expect("handedOverFrom" in ctx).toBe(false);
  });

  it("E-A02 lets a person who already holds a seat in writable on a full document", async () => {
    const { ctx, connectionConfig, ownSpy } = await capCase({ count: 2, own: "yes" });
    expect(connectionConfig.readOnly).toBe(false);
    expect(ctx.seatCap).toBe(2);
    expect(ownSpy).toHaveBeenCalledTimes(1);
    expect(ownSpy).toHaveBeenCalledWith(CANVAS_DOC, "user-1");
    expect(loggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "connection_cap_degraded" }),
      "connection_cap_degraded",
    );
  });

  // A single failed Redis command, not an outage: the count already answered
  // "full", and the query that would have found this person's own seat is the
  // one that failed. Treating "could not find out" as "holds none" would pin
  // them read-only on their own second tab for the life of that connection.
  it("E-A03 lets a member in writable when the own-seat query failed", async () => {
    const { ctx, connectionConfig } = await capCase({ count: 2, own: "unknown" });
    expect(connectionConfig.readOnly).toBe(false);
    expect(ctx.seatCap).toBe(2);
  });

  it("E-A04 settles for read-only on a full document where the person holds no seat", async () => {
    const { ctx, connectionConfig } = await capCase({ count: 2, own: "no" });
    expect(connectionConfig.readOnly).toBe(true);
    expect(ctx.seatCap).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ liveCount: 2, cap: 2, reason: "connection_cap_degraded" }),
      "connection_cap_degraded",
    );
  });

  it("E-A05 gives a viewer no seat and asks nothing about the cap", async () => {
    const { ctx, connectionConfig, resolveSpy, countSpy, ownSpy } = await capCase({ count: 0, role: "viewer" });
    expect(connectionConfig.readOnly).toBe(true);
    expect(ctx.seatCap).toBeNull();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(countSpy).not.toHaveBeenCalled();
    expect(ownSpy).not.toHaveBeenCalled();
  });

  it("E-A06 gives the meta doc no seat and asks nothing about the cap", async () => {
    const { ctx, connectionConfig, resolveSpy, countSpy, ownSpy } = await capCase({
      count: 999,
      documentName: `project-${PID}/meta`,
    });
    expect(connectionConfig.readOnly).toBe(true);
    expect(ctx.seatCap).toBeNull();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(countSpy).not.toHaveBeenCalled();
    expect(ownSpy).not.toHaveBeenCalled();
  });

  it("E-A07 gives no seat when the ceiling cannot be resolved", async () => {
    const { ctx, connectionConfig } = await capCase({
      count: 0,
      limit: async () => {
        throw new Error("No live admin for studio st-1");
      },
    });
    expect(connectionConfig.readOnly).toBe(true);
    expect(ctx.seatCap).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "connection_limit_unresolved" }),
      "connection_limit_unresolved",
    );
  });

  it("E-A08 gives no seat under a ceiling of zero", async () => {
    const { ctx, connectionConfig } = await capCase({ count: 0, own: "no", limit: 0 });
    expect(connectionConfig.readOnly).toBe(true);
    expect(ctx.seatCap).toBeNull();
  });

  describe("the arrival moment", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("E-A09 is the moment the handshake started, not when it finished", async () => {
      const T = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(T);
      const { ctx } = await capCase({
        count: 0,
        limit: async () => {
          vi.advanceTimersByTime(500);
          return 2;
        },
      });
      expect(ctx.arrivedAtMs).toBe(T);
    });
  });

  it("E-A10 takes nothing that could write a seat: the handshake only counts and asks", () => {
    expectTypeOf<keyof CreateAuthHookOptions>().toEqualTypeOf<
      "redis" | "resolveConnectionLimit" | "countConnections" | "hasOwnSeat"
    >();
  });

  // Every connection handed a ceiling takes a seat in `connected`, and
  // `onDisconnect` releases only documents `shouldTrackConnection` covers
  // (it has no `connectionConfig` to ask about writability). So the documents
  // that get a ceiling must stay inside the ones that are released, or a seat
  // is taken that nothing ever gives back.
  it("only ever hands a ceiling to a document the disconnect side releases", async () => {
    const names = [CANVAS_DOC, `project-${PID}/document-${DOC_SID}`, `project-${PID}/meta`];
    for (const documentName of names) {
      for (const role of ["owner", "editor", "viewer"]) {
        for (const own of ["yes", "no", "unknown"] as const) {
          for (const count of [0, 2]) {
            const { ctx } = await capCase({ count, own, role, documentName });
            if (ctx.seatCap !== null) expect(shouldTrackConnection(documentName)).toBe(true);
          }
        }
      }
    }
  });

  it("skips the cluster-wide count for a viewer (already read-only, no wasted Redis round-trip)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("viewer");
    const countSpy = vi.fn(async () => 0);
    const hook = buildHook({ connectionLimit: 2, countConnections: countSpy });
    const connectionConfig = { readOnly: false };

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    // Viewer is read-only regardless, and the cap count is skipped.
    expect(connectionConfig.readOnly).toBe(true);
    expect(countSpy).not.toHaveBeenCalled();
  });

  it("logs `connection_cap_degraded` warn when an editor drops to read-only at cap", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook({
      connectionLimit: 2,
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

  // ── The ceiling now comes from the tier (#88) ──────────────────────

  it("degrades the OWNER too when the doc is full — there is no reserved seat", async () => {
    // The load-bearing case for "no reserved seat" (user 2026-08-14,
    // reversing the 2026-08-12 ratification). One predicate, everybody on
    // it: an owner arriving at a full document is read-only exactly like
    // anyone else.
    //
    // Four products were checked and none reserves a seat for the owner —
    // Confluence, Figma and Miro have nothing of the kind, and Google Docs
    // prioritises the owner once the file is full, which is a different
    // mechanism (it never leaves a seat empty while the owner is away).
    // Reserving one costs every document a usable seat for as long as the
    // owner is not in it.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    const hook = buildHook({
      connectionLimit: 2,
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

  it("keeps the owner writable below the cap, like everyone else", async () => {
    // The other half of the same rule: no reserved seat does not mean the
    // owner is treated worse either. One predicate, read the same way.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    const hook = buildHook({
      connectionLimit: 2,
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

  it("treats a ceiling of zero as a real zero: not one writable connection", async () => {
    // `concurrent_editors: 0` used to mean "unlimited" here — auth.ts
    // guarded the whole block behind `maxConnectionsPerDoc > 0`. That
    // contradicts the repo-wide rule that a quota of zero is a real zero
    // (packages/core/AGENTS.md#membership-limits: there is no "unlimited"
    // value, so zero means zero), which every other ceiling already follows —
    // `base.team_studios: 0` in the same file means exactly zero.
    //
    // Failing the other way is the dangerous direction: someone lowering a
    // tier to 0 to stop concurrent editing would have got unlimited
    // concurrent editing, silently.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook({
      connectionLimit: 0,
      countConnections: async () => 0,
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

  it("asks for the ceiling of the project this document belongs to", async () => {
    // The ceiling is per-project now, so the wrong project id would hand a
    // document somebody else's tier — and nothing downstream would notice,
    // because the number that comes back looks perfectly valid.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const resolveSpy = vi.fn(async () => 5);
    const hook = buildHook({
      connectionLimit: resolveSpy,
      countConnections: async () => 0,
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig: { readOnly: false },
    });

    expect(resolveSpy).toHaveBeenCalledWith(PID);
  });

  it("degrades to read-only when the tier cannot be resolved, rather than refusing the connection", async () => {
    // user 2026-08-14. The lookup throws on three data conditions, all of
    // them ours and none of them the user's doing: a tier value outside the
    // enum (an operator's typo while upgrading somebody by hand), a missing
    // account, a studio with no live admin.
    //
    // What that lookup answers is "how many writable connections", and
    // being able to READ does not depend on it — refusing the connection
    // would take away a capability that has nothing to do with the part
    // that broke. Reading also cannot damage anything, so there is nothing
    // for fail-fast to protect here.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook({
      connectionLimit: async () => {
        throw new Error("Unknown membership tier 'Pro' on account acc-1");
      },
      countConnections: async () => 0,
    });
    const connectionConfig = { readOnly: false };

    // Must not throw: the catch-all in auth.ts re-raises anything it does
    // not recognise, and Hocuspocus closes the socket on a throw.
    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/canvas-${SID}`,
        requestHeaders: withCookie("tok"),
        connectionConfig,
      }),
    ).resolves.toBeDefined();

    expect(connectionConfig.readOnly).toBe(true);
  });

  it("logs what an operator needs when the tier cannot be resolved", async () => {
    // The row an operator has to go fix is not in this log's reach, so the
    // log has to carry the error's own message — that is where the account
    // id and the offending value live (membership.repo.ts puts both in).
    // Without it the trail says only "somebody somewhere has a bad tier".
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook({
      connectionLimit: async () => {
        throw new Error("Unknown membership tier 'Pro' on account acc-1");
      },
      countConnections: async () => 0,
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig: { readOnly: false },
    });

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PID,
        userId: "user-1",
        reason: "connection_limit_unresolved",
        err: expect.objectContaining({
          message: "Unknown membership tier 'Pro' on account acc-1",
        }),
      }),
      "connection_limit_unresolved",
    );
  });

  it("does not consult the count when the tier cannot be resolved", async () => {
    // Read-only is already decided at that point, so the Redis round-trip
    // buys nothing — same reasoning as the viewer case above.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const countSpy = vi.fn(async () => 0);
    const hook = buildHook({
      connectionLimit: async () => {
        throw new Error("No live admin for studio st-1");
      },
      countConnections: countSpy,
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig: { readOnly: false },
    });

    expect(countSpy).not.toHaveBeenCalled();
  });

  it("never resolves a ceiling for the meta doc", async () => {
    // The meta doc is exempt from the cap, so it must not pay for a tier
    // lookup on every handshake — and, more to the point, a studio with
    // broken tier data must not lose its meta doc, which is what everyone
    // needs to see the project at all.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const resolveSpy = vi.fn(async () => 2);
    const hook = buildHook({
      connectionLimit: resolveSpy,
      countConnections: async () => 999,
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
      connectionConfig: { readOnly: false },
    });

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("never resolves a ceiling for a viewer", async () => {
    // Same reasoning as skipping the count for a viewer: they are read-only
    // whatever the ceiling says, so asking costs a database round-trip on
    // every viewer handshake and buys nothing.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("viewer");
    const resolveSpy = vi.fn(async () => 2);
    const hook = buildHook({
      connectionLimit: resolveSpy,
      countConnections: async () => 0,
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig: { readOnly: false },
    });

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  // NOTE: registration into the cross-instance registry no longer happens
  // in this hook — it moved to the `connected` lifecycle hook so it stays
  // symmetric with the onDisconnect unregister (#1421 phantom-leak fix;
  // see hocuspocus.ts `shouldTrackConnection` + its test). The auth hook
  // has no registry handle at all, so it structurally cannot register.

  it("accepts an active viewer; connection forced read-only (connectionConfig.readOnly mutated — the property Hocuspocus enforces)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("viewer");
    const hook = buildHook();
    const connectionConfig = { readOnly: false };

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/canvas-${SID}`,
      requestHeaders: withCookie("tok"),
      connectionConfig,
    });

    expect(ctx).toEqual({
      user: { id: "user-1", role: "viewer" },
      seatCap: null,
      arrivedAtMs: expect.any(Number),
      session: { token: "tok", id: createHash("sha256").update("tok").digest("hex") },
    });
    // SECURITY INVARIANT (root-caused 2026-06-18). The hook MUST mutate
    // connectionConfig.readOnly: Hocuspocus reads THIS when constructing
    // the Connection and rejects every incoming sync-update on a read-only
    // connection (hocuspocus-server messageYjsUpdate / syncStep2 handlers).
    // The prior bug returned `{ connection: { readOnly } }`, which only
    // populated `context` — a value Hocuspocus never reads — so viewers
    // could drag canvas nodes around via raw Yjs.
    expect(connectionConfig.readOnly).toBe(true);
  });

  // ── Space existence: the check answers from the list this process holds ──
  //
  // The client only asks for a Space's content doc because it was told the
  // Space exists, and what told it is the in-memory meta doc this process
  // broadcast. So the check reads that list — and makes sure this process
  // holds one before it answers. There is no second source: `space:create`
  // writes the in-memory doc and broadcasts it while the stored row trails
  // by up to one store tick, so deciding from storage refused connections to
  // Spaces this very process had just announced.

  it("accepts a Space the held list knows about, without loading anything", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook({
      documents: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID, DOC_SID])]]),
    });

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${DOC_SID}`,
      requestHeaders: withCookie("tok"),
    });

    expect(ctx.user.id).toBe("user-1");
    expect(createDocumentSpy).not.toHaveBeenCalled();
  });

  it("refuses a Space the held list has dropped", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook({
      documents: new Map([
        [`project-${PID}/meta`, liveMetaWithSpaces(["other-space-id"])],
      ]),
    });

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/document-${DOC_SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/does not exist/);
    expect(createDocumentSpy).not.toHaveBeenCalled();
  });

  it("refuses a content doc whose kind is not the listed Space's type", async () => {
    // SID is a canvas Space. A document doc under the same id is a row the
    // project never listed, so it would add one to the live Space count.
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook();

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/document-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("treats a held list with no Spaces as an answer, not as absence", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    // The one way to write this wrong: an empty list is easy to collapse into
    // "nothing here", which would send the check off to load a second copy of
    // a document it is already holding — for the very project whose last
    // Space was just deleted.
    const hook = buildHook({
      documents: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([])]]),
    });

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/document-${DOC_SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/does not exist/);
    expect(createDocumentSpy).not.toHaveBeenCalled();
  });

  it("loads the list when this process holds none, and answers from what it loaded", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook({
      documents: new Map(),
      loadable: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID, DOC_SID])]]),
    });

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${DOC_SID}`,
      requestHeaders: withCookie("tok"),
    });

    expect(ctx.user.id).toBe("user-1");
    expect(createDocumentSpy).toHaveBeenCalledWith(
      `project-${PID}/meta`,
      expect.anything(),
      "socket-1",
      { isAuthenticated: true, readOnly: true },
    );
  });

  it("loads the meta doc of the project the document belongs to, not any other", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const otherPid = "33333333-3333-4333-8333-333333333333";
    // A held list for a DIFFERENT project, listing the requested Space.
    // Keying the lookup on anything but this project's own meta doc name
    // would let it answer here.
    const hook = buildHook({
      documents: new Map([
        [`project-${otherPid}/meta`, liveMetaWithSpaces([SID, DOC_SID])],
      ]),
      loadable: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID, DOC_SID])]]),
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${DOC_SID}`,
      requestHeaders: withCookie("tok"),
    });

    expect(createDocumentSpy).toHaveBeenCalledWith(
      `project-${PID}/meta`,
      expect.anything(),
      "socket-1",
      expect.anything(),
    );
  });

  it("refuses when the loaded list turns out to be empty", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    // Nothing held and nothing to load: the framework hands back an empty
    // document, so this project has no Spaces.
    const hook = buildHook({ documents: new Map(), loadable: new Map() });

    await expect(
      hook({
        token: PLACEHOLDER_TOKEN,
        documentName: `project-${PID}/document-${DOC_SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("puts back a list it loaded, and only one it loaded", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const loaded = liveMetaWithSpaces([SID, DOC_SID]);
    const hook = buildHook({
      documents: new Map(),
      loadable: new Map([[`project-${PID}/meta`, loaded]]),
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${DOC_SID}`,
      requestHeaders: withCookie("tok"),
    });

    // Scheduled rather than awaited, so give the microtask queue a turn.
    await Promise.resolve();
    expect(unloadDocumentSpy).toHaveBeenCalledWith(loaded);
  });

  it("does not put back a list it found already held", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const hook = buildHook({
      documents: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID, DOC_SID])]]),
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${DOC_SID}`,
      requestHeaders: withCookie("tok"),
    });

    await Promise.resolve();
    expect(unloadDocumentSpy).not.toHaveBeenCalled();
  });

  it("logs rather than swallows a failed unload", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    unloadDocumentSpy.mockRejectedValue(new Error("unload blew up"));
    const hook = buildHook({
      documents: new Map(),
      loadable: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID, DOC_SID])]]),
    });

    // The handshake still succeeds: housekeeping failing is not the caller's
    // problem, but it must not disappear either.
    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${DOC_SID}`,
      requestHeaders: withCookie("tok"),
    });
    expect(ctx.user.id).toBe("user-1");

    await vi.waitFor(() => {
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ documentName: `project-${PID}/meta` }),
        "meta_doc_unload_after_read_failed",
      );
    });
  });

  it("does not consult the document table for the meta doc itself", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    // The meta doc carries no spaceId to check, so the lookup must not happen
    // at all. Asserting only that the connection is accepted would not say
    // that: the check could run, read this copy, and have its verdict thrown
    // away by the `kind !== "meta"` guard — indistinguishable from outside.
    const watched = watchedDocuments([
      [`project-${PID}/meta`, liveMetaWithSpaces([])],
    ]);
    const hook = buildHook({ documents: watched.documents });

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: withCookie("tok"),
    });

    expect(ctx.user.id).toBe("user-1");
    expect(watched.get).not.toHaveBeenCalled();
    expect(createDocumentSpy).not.toHaveBeenCalled();
  });



  it("parses the session value when other cookies appear before it", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("owner");
    const hook = buildHook();

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/meta`,
      requestHeaders: new Headers({
        cookie: "first=1; breatic_session=real-token; third=3",
      }),
      connectionConfig: { readOnly: false },
    });

    expect(ctx.user.id).toBe("user-1");
    // The session store is queried with the *real* cookie value, not
    // the placeholder application-level token — pins that the cookie
    // value is what reaches core's getSession.
    expect(getSessionMock).toHaveBeenCalledWith(mockRedis, "real-token");
  });

  // ── Server-side log trail (AGENTS.md#application-layer-error-logging) ──
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
        requestHeaders: new Headers(),
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
