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
import { DEV_USER_ID, parseDocName } from "@breatic/shared";
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
    // NoAccount mode: skip auth, use dev user with full permission.
    // Dev/test only — startup gate (collab/index.ts) refuses to start
    // in production with LOGIN_MODE=NoAccount.
    if (process.env["LOGIN_MODE"] === "NoAccount") {
      if (process.env["ENV"] === "prod") {
        throw new Error("NoAccount mode forbidden in production");
      }
      return {
        user: { id: DEV_USER_ID, role: "owner" },
        connection: { readOnly: false },
      };
    }

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

    return {
      user: { id: userId, role },
      connection: {
        readOnly: role === "view",
      },
    };
  };
}
