// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 *      project's `meta.spaces` (delegated to `readProjectSpaceIds`); a
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
 * source and this file issues no SQL for it. See `readProjectSpaceIds` in
 * `@collab/services/project-space-list.js`.
 */

import type { Redis } from "@breatic/core";
import {
  readProjectSpaceIds,
  type DocumentRegistry,
} from "@collab/services/project-space-list.js";
import {
  createLogger,
  getSession,
  projectAuthService,
  sessionCookieName,
} from "@breatic/core";
import { parseDocName } from "@breatic/shared";
import type { ProjectRole } from "@breatic/shared";

/**
 * Auth hook logger - every onAuthenticate decision (success or
 * failure) lands here with structured context. Per the
 * CLAUDE.md "industrial-grade server standards" mandate: every server-side error
 * path must leave a server-side log trail so a 3am oncall can
 * trace from "user sees banner stuck" back to the root cause
 * (e.g. stale Redis client, dropped Postgres connection,
 * membership lookup miss) without resorting to client-side
 * inference.
 */
const logger = createLogger("auth");

/**
 * Tiny RFC-6265 cookie parser. Hocuspocus only gives us the raw
 * `Cookie:` header string, so we hand-roll instead of pulling a
 * Hono-coupled cookie helper.
 *
 * Returns the value of the named cookie or null if absent.
 * @param header - Raw `Cookie:` header string from the WebSocket upgrade request, or undefined when no cookies were sent.
 * @param name - Name of the cookie to extract.
 * @returns The decoded value of the named cookie, or null when the header is absent or the cookie is not present.
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  // Cookie header is `name1=val1; name2=val2`. Trim each pair so
  // leading spaces after `; ` do not break matching.
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return null;
}

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
   * at once, read from the membership tier of the studio that owns the
   * project (#88). It is a per-project lookup rather than a constant
   * because the answer belongs to that studio's current admin, and
   * adminship transfers.
   *
   * ZERO IS A REAL ZERO — not one writable connection. Every ceiling in
   * `config/membership.yaml` reads that way (`base.team_studios: 0` is a
   * genuine zero), and there is no sentinel for "unlimited": a deployment
   * that does not want to cap this writes a number nobody reaches.
   *
   * THROWING IS EXPECTED and does not refuse the connection: the lookup
   * raises when our own data is wrong (a tier value outside the enum after
   * a hand-written UPDATE, a missing account, a studio with no live admin).
   * What it answers is how many may WRITE, and reading does not depend on
   * it, so the caller degrades the connection to read-only and logs.
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
}

/**
 * Create the onAuthenticate hook for Hocuspocus.
 *
 * Returns a function that Hocuspocus calls on every WS handshake.
 * Throwing rejects the connection (4401 / 4403). Returning sets
 * `c.context.user` for the handlers that read it downstream —
 * `onStateless` (the caller's id and role on every `space:*` / `tab:*` RPC),
 * `connected` and `onDisconnect` (presence), and `beforeHandleMessage`.
 * @param root0 - Hook construction options.
 * @param root0.redis - Redis client used to resolve the session token through core's shared session store.
 * @param root0.resolveConnectionLimit - Reads the writable-connection ceiling for a project from its studio's membership tier; a zero is a real zero, and a throw degrades this connection to read-only rather than refusing it. The meta doc never asks.
 * @param root0.countConnections - Counts a document's live connections cluster-wide (this connection not included) to evaluate the cap.
 * @returns The Hocuspocus `onAuthenticate` handler that resolves the authenticated user, mutates `connectionConfig.readOnly` — always for the meta doc, and for view-only members, at-capacity documents or an unresolvable ceiling — and returns the user context, or throws to reject the connection.
 */
export function createAuthHook({
  redis,
  resolveConnectionLimit,
  countConnections,
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
    // Every decision below - accept or reject - logs structured
    // context (no PII beyond userId + documentName). The previous
    // bare-throw style let onAuthenticate fail silently from the
    // server's perspective: the client got "Unauthorized" and
    // surfaced the banner, but `oncall` had no server-side trail
    // to confirm whether the rejection came from a missing cookie,
    // expired Redis session, dropped Postgres connection, or
    // membership lookup miss. Per the CLAUDE.md "industrial-grade server standards" mandate and memory `feedback_dev_collab_long_running_drift`,
    // every rejection logs first then throws, and the outer
    // try/catch surfaces unexpected infrastructure errors
    // (Redis/Postgres connection-level failures) with the same
    // `auth_unexpected_error` tag so a single grep finds them.
    try {
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
      // refuse the connection if the spaceId is no longer in `meta.spaces`.
      // This is the runtime half of "delete a Space = remove its id from
      // meta.spaces; PG row stays for recovery but new connections cannot
      // load it" (ADR 2026-05-23-yjs-collab-only-write-authz §B1.5).
      if (parsed.kind !== "meta") {
        const ids = await readProjectSpaceIds(
          parsed.projectId,
          instance,
          request,
          socketId,
        );
        if (!ids.has(parsed.spaceId)) {
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
          // Carry `err` through verbatim: the structured fields beside it
          // narrow the search but never name the row, and without the message
          // the trail says merely "some studio has bad data".
          //
          // How much the message narrows it varies, and it is worth knowing
          // which case you are in before going to look:
          //
          //   `Unknown membership tier "X" on account <uid>, the admin of
          //     studio <sid>`  — the one that names its row outright: that
          //     `users` row, and the offending value with it.
          //   `No live admin for studio <sid>`  — narrows to a studio, NOT to
          //     a table. `readStudioAdmin` joins three of them and any of four
          //     liveness conditions failing yields this same string, so the bad
          //     row may be in `studios`, in `studio_members`, or in the admin's
          //     `users` row. Its own docstring lists all three.
          //   `No live project <pid>`  — a `projects` row.
          //   anything else  — most likely the config file. `getLimitsForStudio`
          //     ends at `getMembershipLimits`, which lazily reads and validates
          //     `config/membership.yaml` on first use, so a malformed file
          //     surfaces here as a ZodError naming no row at all. That one is
          //     not per-studio: it degrades every writable connection in the
          //     deployment until the file is fixed.
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
      // RPC (`space:*` / `tab:*` on the stateless channel, which read-only
      // does not touch) and the client's own connection cannot write.
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

      // NOTE: this connection is registered in the cross-instance registry
      // by the `connected` lifecycle hook (see hocuspocus.ts), NOT here.
      // Registration is deliberately bound to the Connection object's
      // existence so it is symmetric with the onDisconnect unregister:
      // Hocuspocus fires `connected` only after it creates the Connection
      // (and wires its onClose → onDisconnect), and fires onDisconnect only
      // for such connections. Registering in this hook instead would leak a
      // phantom member for any connection that passes auth but then fails
      // during document load (no Connection object → no onDisconnect ever),
      // whose member the per-instance heartbeat would refresh forever (#1421).
      return {
        user: { id: userId, role },
      };
    } catch (err) {
      // The walks above log + throw on auth-policy rejections
      // (reason in {missing_cookie, session_not_found,
      // doc_name_invalid, not_member, space_deleted}). Anything
      // landing here without one of those tags is an unexpected
      // infrastructure failure - Redis ping fail, postgres-js
      // connection drop, Yjs lib error. We log with `unexpected`
      // tag so dashboards can split "policy reject" vs "infra
      // fail" trends and re-throw so Hocuspocus still closes the
      // socket with 4401 (the client sees the same banner state
      // either way; only the server-side trail differs).
      const e = err as Error;
      const isKnownReject =
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
