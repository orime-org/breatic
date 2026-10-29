// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Hocuspocus authentication hook (v10 multi-doc).
 *
 * Performs four checks before a client is allowed to open or
 * subscribe to a document:
 *
 *   1. The supplied session cookie resolves to a user id (delegated to
 *      core `getSession`, the same Redis-backed store the API server
 *      writes / reads through).
 *   2. The `documentName` matches the v10 multi-doc convention -
 *      `project-{pid}/meta` or `project-{pid}/{kind}-{spaceId}` for
 *      `kind ∈ {canvas, document, timeline}`. Legacy single-doc
 *      `project-{pid}` and pre-v10 `project-{pid}/canvas` /
 *      `/node/{id}` forms are rejected outright.
 *   3. The user has an active role on the doc's project (delegated to
 *      core `projectAuthService.loadProjectRole`). For view-only members
 *      the hook MUTATES `connectionConfig.readOnly = true` (the field
 *      Hocuspocus reads when it builds the Connection), so every incoming
 *      Yjs sync-update is rejected at the protocol level — no UI trust.
 *   4. For a Space content doc, the spaceId is still listed in the
 *      project's `meta.spaces` under that same type (delegated to
 *      `readListedContentDocNames`); a
 *      Space that has left the list refuses new connections. The meta doc
 *      itself skips this check — it is the list.
 *
 * Cross-tenant probing is impossible by design: any doc whose
 * projectId the caller is not a member of is rejected with the
 * same generic error, regardless of whether the project actually
 * exists (`loadProjectRole` collapses missing-project and
 * no-membership to the same `null`).
 *
 * Session + role resolution live in `@breatic/core` because auth must
 * be identical across every backend service. collab used to hand-roll
 * its own copies (raw `redis.get` for the session, raw SQL for the
 * role), which drifted from the server's path; both now call the one
 * shared kernel. The Yjs space-existence check reads the meta doc this
 * process holds, and loads one when it holds none — there is no second
 * source and this file issues no SQL for it. See `readListedContentDocNames` in
 * `@collab/services/project-space-list.js`.
 */

import type { Redis } from "@breatic/core";
import { readCookie } from "@collab/infra/cookie.js";
import {
  readListedContentDocNames,
  type DocumentRegistry,
} from "@collab/services/project-space-list.js";
import {
  createLogger,
  env,
  getSession,
  projectAuthService,
  sessionCookieName,
  sessionId,
} from "@breatic/core";
import type { OwnSeat } from "@collab/services/connection-registry.js";
import { parseDocName } from "@breatic/shared";
import type { ProjectRole } from "@breatic/shared";

/**
 * Auth hook logger - every onAuthenticate decision (success or
 * failure) lands here with structured context. Per the
 * AGENTS.md#application-layer-error-logging rule: every server-side error
 * path must leave a server-side log trail so a 3am oncall can
 * trace from "user sees banner stuck" back to the root cause
 * (e.g. stale Redis client, dropped Postgres connection,
 * membership lookup miss) without resorting to client-side
 * inference.
 */
const logger = createLogger("auth");

/**
 * Resolved user context returned to Hocuspocus. The return value is
 * merged into the connection `context` (read downstream via
 * `context.user` by onStateless / awareness).
 *
 * Read-only is NOT carried here: it is applied by mutating the passed-in
 * `connectionConfig.readOnly` (see the hook body), because Hocuspocus
 * reads `connectionConfig` — not the returned context — when it builds
 * the Connection.
 */
export interface AuthContext {
  user: {
    id: string;
    role: ProjectRole;
  };
  /**
   * The ceiling this handshake judged the connection by, or null when it
   * takes no seat (meta doc, viewer, full document where the person holds no
   * seat, unresolvable ceiling). The `connected` hook takes the seat
   * atomically under this cap; nothing is taken here, because the framework
   * can still abandon the connection before `connected`.
   */
  seatCap: number | null;
  /**
   * Epoch ms this handshake began. It orders one person's connections when a
   * full document's seat is replaced: only an earlier arrival can be.
   */
  arrivedAtMs: number;
  /**
   * The session this connection was opened with: the token, to read it again,
   * and its id (core `sessionId`), to match announcements of ended sessions
   * (inner#1548). Held in this process's memory only.
   */
  session: { token: string; id: string };
}

/**
 * Minimal shape of Hocuspocus's mutable per-connection config
 * (`onAuthenticatePayload.connectionConfig`). The auth hook flips
 * `readOnly` on it as a side effect. Declared locally so this module
 * does not depend on hocuspocus types.
 */
interface MutableConnectionConfig {
  readOnly: boolean;
}

/**
 * Options required to build the auth hook.
 *
 * Redis is the only backing store handed in — the other two fields configure
 * the connection cap rather than reaching a store. The session lookup uses
 * Redis (through core's shared session store) and the role lookup routes
 * through core (`projectAuthService.loadProjectRole`) over the shared `db`
 * singleton — no collab-owned Postgres pool. The space-existence check needs
 * nothing here at all: it works off the running Hocuspocus server, which the
 * framework hands the hook on every handshake.
 */
export interface CreateAuthHookOptions {
  redis: Redis;
  /**
   * How many writable connections one of this project's documents may hold
   * at once, resolved from its Studio's current admin membership reading.
   * Configured or negotiated concurrent_editors and expiry are resolved
   * together for this handshake; an admin transfer changes the source.
   *
   * ZERO IS A REAL ZERO — not one writable connection. Every ceiling in
   * `config/membership.yaml` reads that way (`base.team_studios: 0` is a
   * genuine zero), and there is no sentinel for "unlimited": a deployment
   * that does not want to cap this writes a number nobody reaches.
   *
   * An unresolved limit grants read-only access and logs the cause. Reasons
   * include an unknown tier, an absent live account or admin, invalid saved
   * information, and legacy enterprise information awaiting completion.
   */
  resolveConnectionLimit: (projectId: string) => Promise<number>;
  /**
   * Count the document's live connections CLUSTER-WIDE (via the
   * cross-instance registry, #1421) — not just this process's local
   * connections, so a doc cannot hold N×cap connections across N
   * instances before any of them trips the cap. This connection is NOT
   * included: registration happens in the `connected` lifecycle hook
   * (after this hook returns and the Connection object exists), so a
   * connection never counts against its own cap check. When the count is
   * already at the cap, this connection is degraded to read-only instead
   * of being rejected (mirrors Figma / Google Docs "the file is full →
   * you can view but not edit"). Returns a Promise because the count is a
   * Redis round-trip.
   */
  countConnections: (documentName: string) => Promise<number>;
  /**
   * Whether an arriving person already holds a seat on a document that is
   * full. `yes` lets them in writable: the `connected` hook then replaces one
   * of their earlier seats atomically, and that tab goes read-only instead.
   * `unknown` (Redis could not answer) lets them in too; `no` settles for
   * read-only.
   */
  hasOwnSeat: (documentName: string, userId: string) => Promise<OwnSeat>;
}

/**
 * Create the onAuthenticate hook for Hocuspocus.
 *
 * Hocuspocus calls this for each document's authentication on the shared socket.
 * Throwing sends a document permission-denied response and clears its pending
 * authentication state. Returning sets
 * `c.context.user` for the handlers that read it downstream —
 * `onStateless` (the caller's id and role on every `space:*` RPC),
 * `connected` and `onDisconnect` (presence), and `beforeHandleMessage`.
 * @param root0 - Hook construction options.
 * @param root0.redis - Redis client used to resolve the session token through core's shared session store.
 * @param root0.resolveConnectionLimit - Reads the writable-connection ceiling for a project from its studio's membership tier; a zero is a real zero, and a throw degrades this connection to read-only rather than refusing it. The meta doc never asks.
 * @param root0.countConnections - Counts a document's live connections cluster-wide (this connection not included) to evaluate the cap.
 * @param root0.hasOwnSeat - Asks whether the arriving person already holds a seat when the document is full, so nobody is kept out by themselves.
 * @returns The Hocuspocus `onAuthenticate` handler that resolves the authenticated user, mutates `connectionConfig.readOnly` — always for the meta doc, and for view-only members, at-capacity documents or an unresolvable ceiling — and returns the user context, or throws to reject the connection.
 */
export function createAuthHook({
  redis,
  resolveConnectionLimit,
  countConnections,
  hasOwnSeat,
}: CreateAuthHookOptions) {
  return async ({
    documentName,
    requestHeaders,
    connectionConfig,
    instance,
    request,
    socketId,
  }: {
    token: string;
    documentName: string;
    requestHeaders: Headers;
    connectionConfig: MutableConnectionConfig;
    /** The running Hocuspocus server, for the meta doc it holds or can load. */
    instance: DocumentRegistry;
    /** The upgrade request, passed through when a meta doc has to be loaded. */
    request: Request;
    /** This connection's socket id, passed through on the same path. */
    socketId: string;
  }): Promise<AuthContext> => {
    // Taken first: every retry of this connection's seat orders by when the
    // handshake began, not by how long the lookups below took.
    const arrivedAtMs = Date.now();
    // Every decision below - accept or reject - logs structured
    // context (no PII beyond userId + documentName). The previous
    // bare-throw style let onAuthenticate fail silently from the
    // server's perspective: the client got "Unauthorized" and
    // surfaced the banner, but `oncall` had no server-side trail
    // to confirm whether the rejection came from a missing cookie,
    // expired Redis session, dropped Postgres connection, or
    // membership lookup miss. Per AGENTS.md#application-layer-error-logging,
    // every rejection logs first then throws, and the outer
    // try/catch surfaces unexpected infrastructure errors
    // (Redis/Postgres connection-level failures) with the same
    // `auth_unexpected_error` tag so a single grep finds them.
    try {
      // Browser handshakes always carry Origin. Non-browser clients still
      // require a valid session and project membership below.
      const origin = requestHeaders.get("origin");
      if (origin && !env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).includes(origin)) {
        logger.warn({ documentName, reason: "origin_not_allowed" }, "auth_rejected");
        throw new Error("Origin not allowed");
      }
      // Session token travels exclusively as the httpOnly session
      // cookie (`sessionCookieName()`) sent on the WebSocket upgrade
      // request (2026-05-26 cookie migration). Hocuspocus's own
      // `token` field - sent by the client in the application-level
      // auth frame - is treated as opaque and ignored; the client
      // sends a placeholder like `"__cookie_auth__"` purely to trip
      // Hocuspocus into invoking this hook (an empty token short-
      // circuits `onAuthenticate` in v3, see ueberdosis/hocuspocus#596).
      const token = readCookie(
        requestHeaders.get("cookie") ?? undefined,
        sessionCookieName(),
      );
      if (!token) {
        logger.warn(
          { documentName, reason: "missing_cookie" },
          "auth_rejected",
        );
        throw new Error("Missing session cookie");
      }

      // Resolve the session through core's shared session store - the
      // same `{env}:session:{token}` key the API server writes, so the
      // collab + server views can never drift on key prefix.
      const userId = await getSession(redis, token);
      if (!userId) {
        logger.warn(
          { documentName, reason: "session_not_found" },
          "auth_rejected",
        );
        throw new Error("Invalid or expired session token");
      }

      const parsed = parseDocName(documentName);
      if (!parsed) {
        logger.warn(
          { userId, documentName, reason: "doc_name_invalid" },
          "auth_rejected",
        );
        throw new Error(
          `Document '${documentName}' is not in a recognized project format`,
        );
      }

      // Resolve the role through core's shared auth primitive - the
      // same `loadProjectRole` the server `requireRole` middleware
      // calls. `null` means project missing/deleted OR not a member;
      // both collapse so we never leak project existence.
      const role = await projectAuthService.loadProjectRole(
        userId,
        parsed.projectId,
      );
      if (!role) {
        logger.warn(
          {
            userId,
            documentName,
            projectId: parsed.projectId,
            reason: "not_member",
          },
          "auth_rejected",
        );
        throw new Error(
          `User ${userId} is not authorized to access project ${parsed.projectId}`,
        );
      }

      // For Space content docs (canvas-{id} / document-{id} / timeline-{id})
      // refuse the connection unless `meta.spaces` lists this Space under
      // this kind. This is the runtime half of "delete a Space = remove its id
      // from meta.spaces; PG row stays for recovery but new connections cannot
      // load it" (ADR 2026-05-23-yjs-collab-only-write-authz §B1.5). Matching
      // the kind too keeps a doc of another kind under a listed id from ever
      // being stored, so the live Space count the cap reads stays equal to the
      // Spaces in meta.
      if (parsed.kind !== "meta") {
        const listed = await readListedContentDocNames(
          parsed.projectId,
          instance,
          request,
          socketId,
        );
        if (!listed.has(documentName)) {
          logger.warn(
            {
              userId,
              documentName,
              projectId: parsed.projectId,
              spaceId: parsed.spaceId,
              reason: "space_deleted",
            },
            "auth_rejected",
          );
          throw new Error(
            `Space ${parsed.spaceId} does not exist (or has been deleted) in project ${parsed.projectId}`,
          );
        }
      }

      // Apply role-level read-only at the PROTOCOL level by MUTATING the
      // passed-in connectionConfig. Hocuspocus reads
      // `connectionConfig.readOnly` when it constructs the Connection and
      // then rejects every incoming sync-update on a read-only connection
      // (hocuspocus-server messageYjsUpdate / syncStep2 handlers reply
      // syncStatus:false and drop the update). This MUST be a mutation,
      // not a returned value: the hook's return is merged into `context`
      // only, and Hocuspocus never reads `context` for read-only
      // enforcement. Returning `{ connection: { readOnly } }` (the prior
      // bug) left every viewer connection writable — viewers could drag
      // canvas nodes around, bypassing the server path entirely.
      // A connection is read-only when the viewer role forbids writes,
      // OR the document is already at its connection cap, OR it is the
      // meta doc (no client writes that one, see below) — in the cap
      // case we degrade the extra connection to read-only rather
      // than rejecting it (mirrors Figma / Google Docs "the file is full
      // → you can view but not edit").
      //
      // Cap details (#1421 cross-instance):
      //   - The meta doc is EXEMPT. It is project infrastructure everyone
      //     must connect to (member list, presence, Space CRUD), so it is
      //     never a "how many people can collaborate" surface. Only Space
      //     content docs (canvas / document / timeline) carry the cap.
      //   - `countConnections` is CLUSTER-WIDE (cross-instance registry)
      //     and does NOT include this connection — it is registered later,
      //     in the `connected` lifecycle hook (after this hook returns and
      //     the Connection object exists). So the boundary is `>= cap` (the
      //     doc already holds `cap` connections → this one is the extra),
      //     matching the old local `getConnectionsCount() >= cap`.
      //   - The count is evaluated only for roles that would otherwise be
      //     writable: a viewer is already read-only, so we skip the Redis
      //     round-trip (the degrade log below then applies only to a real
      //     drop of an editor / owner).
      //   - THE OWNER GETS NO RESERVED SEAT. One predicate, everybody on
      //     it. Reserving a seat would leave every document one usable
      //     seat short for as long as the owner is not in it, and none of
      //     Confluence / Figma / Miro / Google Docs reserves one (Google
      //     prioritises the owner once a file is full, which never leaves
      //     a seat empty). An owner who is shut out asks a teammate to
      //     leave — user 2026-08-14, reversing the 2026-08-12 position.
      //   - A ceiling of ZERO is a real zero (no writable connection),
      //     like every other quota in the repo. The `> 0` guard that used
      //     to sit here meant "unlimited" and failed in the permissive
      //     direction: lowering a tier to 0 to stop concurrent editing
      //     would silently have allowed unlimited concurrent editing.
      let atCapacity = false;
      let seatCap: number | null = null;
      if (role !== "viewer" && parsed.kind !== "meta") {
        // Resolving the ceiling is the one step here that can fail on OUR
        // data rather than on anything the user did: a tier value outside
        // the enum after a hand-written UPDATE, a missing account, a
        // studio with no live admin. Letting that reach the catch-all
        // below would re-throw and close the socket, taking away the
        // ability to READ — which does not depend on this number at all.
        // So it is caught here and the connection is degraded instead
        // (user 2026-08-14). Reading cannot damage anything, so there is
        // nothing for a fail-fast to protect.
        let cap: number | null = null;
        try {
          cap = await resolveConnectionLimit(parsed.projectId);
        } catch (err) {
          atCapacity = true;
          // Preserve the error with its Project and Studio context. Membership
          // reads can identify an unknown stored tier, an absent live admin or
          // Project, or legacy enterprise information awaiting completion.
          // Configured tiers also validate membership.yaml lazily. Saved
          // enterprise records are validated when the snapshot is read, so a
          // malformed record can also reach this fail-closed path.
          logger.error(
            {
              err,
              userId,
              documentName,
              projectId: parsed.projectId,
              reason: "connection_limit_unresolved",
            },
            "connection_limit_unresolved",
          );
        }

        if (cap !== null) {
          const liveCount = await countConnections(documentName);
          atCapacity = liveCount >= cap;
          if (atCapacity) {
            // Before settling for read-only, ask whether this person already
            // holds a seat here. If they do, this connection is let in
            // writable and the `connected` hook's seat script replaces one of
            // their earlier seats atomically — their other tab is degraded
            // rather than this one, so nobody is ever kept out by themselves.
            // Whether that older connection is alive never enters into it: a
            // reconnect after a blip and a second tab are the same case.
            //
            // `unknown`: the count said full and then Redis stopped
            // answering. Holding this connection read-only on the strength of
            // a query that failed would keep somebody out of their own second
            // tab, which is the one thing this path exists to prevent — and
            // it is the opposite of how the count itself treats a Redis
            // problem. The seat script in `connected` still judges by the cap.
            const own = await hasOwnSeat(documentName, userId);
            if (own !== "no") atCapacity = false;
          }
          if (!atCapacity) seatCap = cap;
          if (atCapacity) {
            // Permanent structured log. The cap degrade was previously
            // silent (baseline smoke found no ops signal) — oncall /
            // metrics need to see when a doc hits the cap and an otherwise-
            // writable member drops to read-only.
            logger.warn(
              {
                userId,
                documentName,
                projectId: parsed.projectId,
                liveCount,
                cap,
                reason: "connection_cap_degraded",
              },
              "connection_cap_degraded",
            );
          }
        }
      }
      // The meta doc is read-only for EVERY client, whatever their role.
      // It is the project's directory, and changing any of it has rules
      // attached — a role to check, a content row to create, a ledger
      // entry, "you cannot delete the last Space". Rules a client can
      // choose not to run are not rules, so every change goes through an
      // RPC (`space:*` on the stateless channel, which read-only does not
      // touch) and the client's own connection cannot write.
      //
      // This replaces a hand-written gate that parsed each frame to see
      // which field it touched. Recognising a write meant enumerating the
      // framework's internal message types, and the gate failed open on
      // every type it missed — it never ran on a real frame in its whole
      // life. Read-only is enforced by the framework at each write site.
      //
      // Content docs are unaffected: a canvas or a document body is the
      // user's own work, it has no rules to enforce, and role decides.
      connectionConfig.readOnly =
        parsed.kind === "meta" || role === "viewer" || atCapacity;

      // NOTE: this connection takes its seat in the cross-instance registry
      // in the `connected` lifecycle hook (see hocuspocus.ts), NOT here; the
      // ceiling and arrival moment travel there in the returned context.
      // Registration is deliberately bound to the Connection object's
      // existence so it is symmetric with the onDisconnect unregister:
      // Hocuspocus fires `connected` only after it creates the Connection
      // (and wires its onClose → onDisconnect), and fires onDisconnect only
      // for such connections. Registering in this hook instead would leak a
      // phantom member for any connection that passes auth but then fails
      // during document load (no Connection object → no onDisconnect ever).
      // That member would hold a seat until it aged out, on a document the
      // connection never reached (#1421).
      return {
        user: { id: userId, role },
        seatCap,
        arrivedAtMs,
        session: { token, id: sessionId(token) },
      };
    } catch (err) {
      // The walks above log + throw on auth-policy rejections
      // (reason in {missing_cookie, session_not_found,
      // doc_name_invalid, not_member, space_deleted}). Anything
      // landing here without one of those tags is an unexpected
      // infrastructure failure - Redis ping fail, postgres-js
      // connection drop, Yjs lib error. We log with `unexpected`
      // tag so dashboards can split "policy reject" vs "infra
      // fail" trends. Re-throwing lets Hocuspocus send the document's
      // permission-denied response and clear its pending authentication state.
      const e = err as Error;
      const isKnownReject =
        e.message === "Origin not allowed" ||
        e.message === "Missing session cookie" ||
        e.message === "Invalid or expired session token" ||
        e.message.startsWith("Document '") ||
        e.message.startsWith("User ") ||
        e.message.startsWith("Space ");
      if (!isKnownReject) {
        logger.error(
          { err: e, documentName },
          "auth_unexpected_error",
        );
      }
      throw err;
    }
  };
}
