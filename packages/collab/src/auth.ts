/**
 * Hocuspocus authentication hook (v10 multi-doc).
 *
 * Performs three checks before a client is allowed to open or
 * subscribe to a document:
 *
 *   1. The supplied session token resolves to a user id in Redis
 *      (`${envPrefix}:session:{token}` on DB0).
 *   2. The `documentName` matches the v10 multi-doc convention —
 *      `project-{pid}/meta` or `project-{pid}/{kind}-{spaceId}` for
 *      `kind ∈ {canvas, document, timeline}`. Legacy single-doc
 *      `project-{pid}` and pre-v10 `project-{pid}/canvas` /
 *      `/node/{id}` forms are rejected outright.
 *   3. The user has an active row in `project_members` for the
 *      doc's projectId. The role is returned so Hocuspocus can
 *      apply `connection.readOnly = true` for view-only members
 *      (writes are blocked at the protocol level — no UI trust).
 *
 * Cross-tenant probing is impossible by design: any doc whose
 * projectId the caller is not a member of is rejected with the
 * same generic error, regardless of whether the project actually
 * exists.
 *
 * Collab is a separate process from the API server. It depends on
 * `@breatic/core` only for shared *infrastructure* — connection
 * factories, configuration, logging — so production-safety knobs
 * (keepAlive / commandTimeout / READONLY reconnect / error
 * logging tags) stay defined in exactly one place across server
 * / collab / worker. The previous "does NOT depend on
 * @breatic/core" convention was revised on 2026-05-27 (PR
 * feat/2026-05-27-collab-infra-resilience) after the long-running
 * dev:collab drift exposed how raw `new IoRedis(url)` / raw
 * `postgres(url, {max:5})` in collab silently drifted from the
 * core defaults. Business logic (`projectAuthService`,
 * `paymentService`, etc.) is still NOT imported from core — the
 * role lookup below remains a raw SQL call so collab can be
 * deployed independently of any API service evolution.
 */

import type Redis from "ioredis";
import type { IncomingHttpHeaders } from "node:http";
import { createPgClient } from "@breatic/core";
import * as Y from "yjs";
import { parseDocName, projectMetaDocName } from "@breatic/shared";
import type { ProjectRole } from "@breatic/shared";

import { createLogger } from "./logger.js";

/**
 * Auth hook logger — every onAuthenticate decision (success or
 * failure) lands here with structured context. Per the
 * CLAUDE.md "服务器端工业级标准" mandate: every server-side error
 * path must leave a server-side log trail so a 3am oncall can
 * trace from "user sees banner stuck" back to the root cause
 * (e.g. stale Redis client, dropped Postgres connection,
 * `loadProjectRole` row mismatch) without resorting to client-side
 * inference.
 */
const logger = createLogger("auth");

/** Must match `packages/core/src/infra/cookie.ts` SESSION_COOKIE_NAME. */
const SESSION_COOKIE_NAME = "breatic_session";

/**
 * Tiny RFC-6265 cookie parser. Hocuspocus only gives us the raw
 * `Cookie:` header string; collab is intentionally core-less (see
 * the module docstring) so we hand-roll instead of pulling a dep.
 *
 * Returns the value of the named cookie or null if absent.
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

/** Resolved user context returned to Hocuspocus. */
export interface AuthContext {
  user: {
    id: string;
    role: ProjectRole;
    /**
     * Human-readable display name (`users.username ?? users.email`),
     * resolved at handshake time so downstream consumers
     * (`space-rpc` actor field on projectMessages) do not have to
     * re-query Postgres on every Space lifecycle event.
     */
    name: string;
    /**
     * Optional avatar URL — flows into `meta.users[userId].avatarUrl`
     * so the bell + members popover can show profile pictures without
     * a separate REST round-trip. Null when the user has not uploaded
     * an avatar yet (Google OAuth users get one auto-set).
     */
    avatarUrl: string | null;
  };
  connection: {
    readOnly: boolean;
  };
}

/**
 * Options required to build the auth hook. The Postgres connection
 * is used for `project_members` role lookups and is pooled (`max: 5`).
 */
export interface CreateAuthHookOptions {
  redis: Redis;
  envPrefix: string;
  databaseUrl: string;
}

/**
 * Load the set of Space ids currently listed in the project's meta
 * Yjs doc. Used to refuse a WebSocket connection to a
 * `project-{pid}/canvas-{deletedSpaceId}` after the Space has been
 * removed from `meta.spaces` (per ADR 2026-05-23-yjs-collab-only-write-authz
 * §"Bootstrap 边界例外" and §"删除可恢复"):
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
 */
async function loadProjectSpaceIds(
  sql: ReturnType<typeof postgres>,
  projectId: string,
): Promise<Set<string>> {
  const docName = projectMetaDocName(projectId);
  const rows = await sql<{ data: Buffer }[]>`
    SELECT data
    FROM yjs_documents
    WHERE name = ${docName} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0 || !rows[0]?.data) return new Set();

  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(rows[0].data));
  const spaces = doc.getMap("spaces");
  return new Set(spaces.keys());
}

/**
 * Resolve the caller's role on a project + display name, or `null` if
 * the project does not exist (or is soft-deleted) OR the user has no
 * active membership. Both branches return null so the caller surfaces
 * a single error and never leaks project existence.
 *
 * `userName` falls back through `users.username` → `users.email` so
 * downstream `actor` fields on projectMessages always render a
 * human-readable string, even for accounts that signed up without a
 * username (Google OAuth path leaves `username` null until profile
 * edit). The fallback chain mirrors `server/src/routes/canvas.ts`
 * `holdingByName` for consistency.
 */
async function loadProjectRole(
  sql: ReturnType<typeof postgres>,
  userId: string,
  projectId: string,
): Promise<{
  role: ProjectRole;
  userName: string;
  avatarUrl: string | null;
} | null> {
  const projectRows = await sql<{ id: string }[]>`
    SELECT id
    FROM projects
    WHERE id = ${projectId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (projectRows.length === 0) return null;

  const memberRows = await sql<{
    role: string;
    username: string | null;
    email: string;
    avatar_url: string | null;
  }[]>`
    SELECT pm.role, u.username, u.email, u.avatar_url
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ${projectId}
      AND pm.user_id = ${userId}
      AND pm.deleted_at IS NULL
      AND u.deleted_at IS NULL
    LIMIT 1
  `;
  const row = memberRows[0];
  if (!row) return null;
  return {
    role: row.role as ProjectRole,
    userName: row.username ?? row.email,
    avatarUrl: row.avatar_url,
  };
}

/**
 * Create the onAuthenticate hook for Hocuspocus.
 *
 * Returns a function that Hocuspocus calls on every WS handshake.
 * Throwing rejects the connection (4401 / 4403). Returning sets
 * `c.context.user` for downstream `onChange` / `broadcastStateless`
 * consumers.
 */
export function createAuthHook({
  redis,
  envPrefix,
  databaseUrl,
}: CreateAuthHookOptions) {
  const sql = createPgClient(databaseUrl, {
    name: "collab-auth",
    max: 5,
  });

  return async ({
    documentName,
    requestHeaders,
  }: {
    token: string;
    documentName: string;
    requestHeaders: IncomingHttpHeaders;
  }): Promise<AuthContext> => {
    // Every decision below — accept or reject — logs structured
    // context (no PII beyond userId + documentName). The previous
    // bare-throw style let onAuthenticate fail silently from the
    // server's perspective: the client got "Unauthorized" and
    // surfaced the banner, but `oncall` had no server-side trail
    // to confirm whether the rejection came from a missing cookie,
    // expired Redis session, dropped Postgres connection, or
    // membership lookup miss. Per the CLAUDE.md "服务器端工业级
    // 标准" mandate and memory `feedback_dev_collab_long_running_drift`,
    // every rejection logs first then throws, and the outer
    // try/catch surfaces unexpected infrastructure errors
    // (Redis/Postgres connection-level failures) with the same
    // `auth_unexpected_error` tag so a single grep finds them.
    try {
      // Session token now travels exclusively as the httpOnly
      // `breatic_session` cookie sent on the WebSocket upgrade
      // request (2026-05-26 cookie migration). Hocuspocus's own
      // `token` field — sent by the client in the application-level
      // auth frame — is treated as opaque and ignored; the client
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

      const userId = await redis.get(`${envPrefix}:session:${token}`);
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

      const member = await loadProjectRole(sql, userId, parsed.projectId);
      if (!member) {
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
      const { role, userName, avatarUrl } = member;

      // For Space content docs (canvas-{id} / document-{id} / timeline-{id})
      // refuse the connection if the spaceId is no longer in `meta.spaces`.
      // This is the runtime half of "delete a Space = remove its id from
      // meta.spaces; PG row stays for recovery but new connections cannot
      // load it" (ADR 2026-05-23-yjs-collab-only-write-authz §B1.5).
      if (parsed.kind !== "meta") {
        const ids = await loadProjectSpaceIds(sql, parsed.projectId);
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

      return {
        user: { id: userId, role, name: userName, avatarUrl },
        connection: {
          readOnly: role === "view",
        },
      };
    } catch (err) {
      // The walks above log + throw on auth-policy rejections
      // (reason in {missing_cookie, session_not_found,
      // doc_name_invalid, not_member, space_deleted}). Anything
      // landing here without one of those tags is an unexpected
      // infrastructure failure — Redis ping fail, postgres-js
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

// `ensureUserInMetaDoc` removed 2026-05-27.
//
// The Q11 v2 server-side path (write `meta.users[userId]` from a
// Hocuspocus lifecycle hook via `openDirectConnection`) deadlocked
// when held inside `afterLoadDocument`, because Hocuspocus
// serializes per-doc work and the inner direct connection to the
// same meta doc could not resolve while the outer hook was still
// awaiting. The fire-and-forget mitigation papered over that race
// but left the deadlock source in the code.
//
// Replacement: a client-driven `users:upsert-self` stateless RPC
// dispatched from the front-end's `onSynced` callback. The handler
// (in `space-rpc.ts::handleUsersUpsertSelf`) writes synchronously
// through the meta doc Y.Doc reference the `onStateless` callback
// already holds — no second connection, no per-doc serialization
// round-trip, no hook reentrancy.
