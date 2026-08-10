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
 * token travels in the httpOnly session cookie on the WebSocket
 * upgrade request (Hocuspocus exposes the upgrade-request headers via
 * `requestHeaders`). The name is deployment-scoped in production
 * (`sessionCookieName()`, #1831); the core mock below pins it to the
 * bare `breatic_session` so these fixtures stay independent of env.
 *
 * Session and role resolution are delegated to `@breatic/core`
 * (`getSession` + `projectAuthService.loadProjectRole`) — the same shared
 * kernel the API server uses, so the two cannot drift. The Yjs
 * space-existence check reads this process's own in-memory documents
 * (staged here as a plain Map) and falls back to collab's
 * `yjsDocumentsRepo.fetchDocData` only when this process holds no meta doc
 * for the project. All three are mocked so the test is hermetic; collab
 * issues no raw SQL of its own.
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
} = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  getSessionMock: vi.fn(),
  loadProjectRoleMock: vi.fn(),
}));

// `@breatic/core` is replaced wholesale so every export auth.ts touches is
// under the test's control and no real session store or database connection
// is ever opened. auth.ts uses exactly five exports — substitute each:
//   - getSession / loadProjectRole: the shared auth kernel, mocked
//   - createLogger: the unified core logger factory, mocked to expose
//     the warn/error spies the log-trail assertions below check
//   - yjsDocumentsRepo.fetchDocData: the single home for `yjs_documents`
//     SQL (the space-existence read), mocked to return a meta blob
//   - sessionCookieName(): the per-deployment cookie name
vi.mock("@breatic/core", () => ({
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
import { createAuthHook } from "../hooks/auth.js";

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
 * @param ids - Space ids to place in `meta.spaces`.
 * @returns The meta `Y.Doc`.
 */
function liveMetaWithSpaces(ids: string[]): Y.Doc {
  const doc = new Y.Doc();
  const spaces = doc.getMap("spaces");
  for (const id of ids) {
    const entry = new Y.Map();
    spaces.set(id, entry);
    entry.set("id", id);
  }
  return doc;
}

const mockRedis = {} as unknown as Redis;

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
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
    maxConnectionsPerDoc?: number;
    countConnections?: (documentName: string) => Promise<number>;
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
    const hook = createAuthHook({
      redis: mockRedis,
      maxConnectionsPerDoc: overrides?.maxConnectionsPerDoc ?? 100,
      countConnections: overrides?.countConnections ?? (async () => 0),
    });
    type HookArgs = Parameters<typeof hook>[0];
    // Default: this process already holds the project's list, and it has the
    // Space these fixtures use. That is the precondition the pre-existing
    // content-doc cases staged through the storage read before #26 — the
    // subject of those cases is roles and caps, not existence.
    const documents =
      overrides?.documents ??
      new Map<string, Y.Doc>([
        [`project-${PID}/meta`, liveMetaWithSpaces([SID])],
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
    // The space-existence read is the only `yjs_documents` access the
    // hook makes — staged through the core repo mock.
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

    expect(ctx).toEqual({ user: { id: "user-1", role: "editor" } });
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
      documentName: `project-${PID}/document-${SID}`,
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
  // doc and stage the space-exists read (meta blob listing SID).

  it("degrades an at-capacity space doc to read-only even for an editor", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
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

  it("exempts the meta doc from the connection cap (project infrastructure — count never consulted)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    // Even far over cap, the meta doc is never degraded — everyone must
    // connect to it (#1421 decision). The cluster-wide count must not even
    // be consulted for meta.
    const countSpy = vi.fn(async () => 999);
    const hook = buildHook({ maxConnectionsPerDoc: 2, countConnections: countSpy });
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

  it("skips the cluster-wide count for a viewer (already read-only, no wasted Redis round-trip)", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("viewer");
    const countSpy = vi.fn(async () => 0);
    const hook = buildHook({ maxConnectionsPerDoc: 2, countConnections: countSpy });
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

    expect(ctx).toEqual({ user: { id: "user-1", role: "viewer" } });
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
      documents: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID])]]),
    });

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${SID}`,
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
        documentName: `project-${PID}/document-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/does not exist/);
    expect(createDocumentSpy).not.toHaveBeenCalled();
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
        documentName: `project-${PID}/document-${SID}`,
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
      loadable: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID])]]),
    });

    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${SID}`,
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
        [`project-${otherPid}/meta`, liveMetaWithSpaces([SID])],
      ]),
      loadable: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID])]]),
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${SID}`,
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
        documentName: `project-${PID}/document-${SID}`,
        requestHeaders: withCookie("tok"),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("puts back a list it loaded, and only one it loaded", async () => {
    getSessionMock.mockResolvedValue("user-1");
    loadProjectRoleMock.mockResolvedValue("editor");
    const loaded = liveMetaWithSpaces([SID]);
    const hook = buildHook({
      documents: new Map(),
      loadable: new Map([[`project-${PID}/meta`, loaded]]),
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${SID}`,
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
      documents: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID])]]),
    });

    await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${SID}`,
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
      loadable: new Map([[`project-${PID}/meta`, liveMetaWithSpaces([SID])]]),
    });

    // The handshake still succeeds: housekeeping failing is not the caller's
    // problem, but it must not disappear either.
    const ctx = await hook({
      token: PLACEHOLDER_TOKEN,
      documentName: `project-${PID}/document-${SID}`,
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
