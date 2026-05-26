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
 * Collab is a separate process from the API server and does NOT
 * depend on @breatic/core (see connectivity-check.ts). The role
 * lookup is therefore a raw SQL call against a postgres-js pool
 * owned by this module — not a re-import of
 * `projectAuthService.loadProjectRole` from core.
 */

import type Redis from "ioredis";
import postgres from "postgres";
import * as Y from "yjs";
import { parseDocName, projectMetaDocName } from "@breatic/shared";
import type { ProjectRole } from "@breatic/shared";

/** Resolved user context returned to Hocuspocus. */
export interface AuthContext {
  user: {
    id: string;
    role: ProjectRole;
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
 * Resolve the caller's role on a project, or `null` if the project
 * does not exist (or is soft-deleted) OR the user has no active
 * membership. Both branches return null so the caller surfaces a
 * single error and never leaks project existence.
 */
async function loadProjectRole(
  sql: ReturnType<typeof postgres>,
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const projectRows = await sql<{ id: string }[]>`
    SELECT id
    FROM projects
    WHERE id = ${projectId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (projectRows.length === 0) return null;

  const memberRows = await sql<{ role: string }[]>`
    SELECT role
    FROM project_members
    WHERE project_id = ${projectId}
      AND user_id = ${userId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return (memberRows[0]?.role as ProjectRole | undefined) ?? null;
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
  const sql = postgres(databaseUrl, { max: 5 });

  return async ({
    token,
    documentName,
  }: {
    token: string;
    documentName: string;
  }): Promise<AuthContext> => {
    if (!token) {
      throw new Error("No authentication token provided");
    }

    const userId = await redis.get(`${envPrefix}:session:${token}`);
    if (!userId) {
      throw new Error("Invalid or expired session token");
    }

    const parsed = parseDocName(documentName);
    if (!parsed) {
      throw new Error(
        `Document '${documentName}' is not in a recognized project format`,
      );
    }

    const role = await loadProjectRole(sql, userId, parsed.projectId);
    if (!role) {
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
      const ids = await loadProjectSpaceIds(sql, parsed.projectId);
      if (!ids.has(parsed.spaceId)) {
        throw new Error(
          `Space ${parsed.spaceId} does not exist (or has been deleted) in project ${parsed.projectId}`,
        );
      }
    }

    return {
      user: { id: userId, role },
      connection: {
        readOnly: role === "view",
      },
    };
  };
}
