// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Hocuspocus authentication hook (v10 multi-doc).
 *
 * Performs three checks before a client is allowed to open or
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
 * shared kernel. The Yjs space-existence read also routes through core
 * (`yjsDocumentsRepo.fetchDocData`, the single home for `yjs_documents`
 * SQL) over the shared `db` singleton — collab issues no raw SQL of its
 * own.
 */

import type { Redis } from "@breatic/core";
import type { IncomingHttpHeaders } from "node:http";
import {
  createLogger,
  getSession,
  projectAuthService,
  SESSION_COOKIE_NAME,
} from "@breatic/core";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";
import * as Y from "yjs";
import { parseDocName, projectMetaDocName } from "@breatic/shared";
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
 * `context.user` by onStateless / beforeHandleMessage / awareness).
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
 * Only Redis is needed: the session lookup uses it (through core's
 * shared session store), while the role lookup and the `yjs_documents`
 * space-existence read route through core (`loadProjectRole` /
 * `yjsDocumentsRepo`) over the shared `db` singleton — no collab-owned
 * Postgres pool.
 */
export interface CreateAuthHookOptions {
  redis: Redis;
  /** Max concurrent connections per document (0 = unlimited). */
  maxConnectionsPerDoc: number;
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
 * Load the set of Space ids currently listed in the project's meta
 * Yjs doc. Used to refuse a WebSocket connection to a
 * `project-{pid}/canvas-{deletedSpaceId}` after the Space has been
 * removed from `meta.spaces` (per ADR 2026-05-23-yjs-collab-only-write-authz
 * §"bootstrap boundary exception" and §"recoverable deletion"):
 *
 *   - `meta.spaces[id] = {...}` is the source of truth for "this
 *     Space exists right now". A soft-deleted `yjs_documents` row for
 *     `canvas-{id}` may still hold the old binary blob for recovery,
 *     but the Space is considered gone the moment its id leaves
 *     `meta.spaces`. New WebSocket connections to that doc name must
 *     be refused so a stale tab cannot resurrect the data.
 *
 * Returns an empty set when the meta row does not exist (a freshly
 * created project's meta doc is always seeded by `yjs-bootstrap`, so
 * the empty-set path is a defensive fallback rather than a real
 * expected state).
 *
 * The `yjs_documents` read goes through the shared core repo — the
 * single home for that table's SQL — over the process-wide `db`
 * singleton, so collab keeps no private pool of its own.
 * @param projectId - Project whose meta Yjs doc holds the authoritative `meta.spaces` set.
 * @returns The set of Space ids currently listed in `meta.spaces`, or an empty set when the meta row is missing.
 */
async function loadProjectSpaceIds(
  projectId: string,
): Promise<Set<string>> {
  const docName = projectMetaDocName(projectId);
  const data = await yjsDocumentsRepo.fetchDocData(docName);
  if (!data) return new Set();

  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(data));
  const spaces = doc.getMap("spaces");
  return new Set(spaces.keys());
}

/**
 * Create the onAuthenticate hook for Hocuspocus.
 *
 * Returns a function that Hocuspocus calls on every WS handshake.
 * Throwing rejects the connection (4401 / 4403). Returning sets
 * `c.context.user` for downstream `onChange` / `broadcastStateless`
 * consumers.
 * @param root0 - Hook construction options.
 * @param root0.redis - Redis client used to resolve the session token through core's shared session store.
 * @param root0.maxConnectionsPerDoc - Per-document concurrent-connection cap (0 = unlimited); at the cap, extra connections degrade to read-only. The meta doc is exempt.
 * @param root0.countConnections - Counts a document's live connections cluster-wide (this connection not included) to evaluate the cap.
 * @returns The Hocuspocus `onAuthenticate` handler that resolves the authenticated user, mutates `connectionConfig.readOnly` for view-only members or at-capacity documents, and returns the user context — or throws to reject the connection.
 */
export function createAuthHook({
  redis,
  maxConnectionsPerDoc,
  countConnections,
}: CreateAuthHookOptions) {
  return async ({
    documentName,
    requestHeaders,
    connectionConfig,
  }: {
    token: string;
    documentName: string;
    requestHeaders: IncomingHttpHeaders;
    connectionConfig: MutableConnectionConfig;
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
      // Session token travels exclusively as the httpOnly
      // `breatic_session` cookie sent on the WebSocket upgrade
      // request (2026-05-26 cookie migration). Hocuspocus's own
      // `token` field - sent by the client in the application-level
      // auth frame - is treated as opaque and ignored; the client
      // sends a placeholder like `"__cookie_auth__"` purely to trip
      // Hocuspocus into invoking this hook (an empty token short-
      // circuits `onAuthenticate` in v3, see ueberdosis/hocuspocus#596).
      const token = readCookie(requestHeaders.cookie, SESSION_COOKIE_NAME);
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
        const ids = await loadProjectSpaceIds(parsed.projectId);
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
      // canvas nodes and tamper meta.projectMeta (name / description)
      // directly via raw Yjs, bypassing the stateless-RPC + requireRole
      // server path entirely.
      // A connection is read-only when EITHER the viewer role forbids
      // writes OR the document is already at its connection cap — in the
      // latter case we degrade the extra connection to read-only rather
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
      let atCapacity = false;
      if (
        role !== "viewer" &&
        parsed.kind !== "meta" &&
        maxConnectionsPerDoc > 0
      ) {
        const liveCount = await countConnections(documentName);
        atCapacity = liveCount >= maxConnectionsPerDoc;
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
              cap: maxConnectionsPerDoc,
              reason: "connection_cap_degraded",
            },
            "connection_cap_degraded",
          );
        }
      }
      connectionConfig.readOnly = role === "viewer" || atCapacity;

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
