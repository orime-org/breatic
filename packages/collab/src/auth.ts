/**
 * Hocuspocus authentication hook.
 *
 * Verifies the client's session token via Redis session store AND
 * enforces per-document project authorization. Without the project
 * check, any logged-in user who knows a target project UUID could
 * open `project-<uuid>/canvas` or `project-<uuid>/node/<nodeId>` and
 * read or write the victim's canvas — document names are predictable
 * by design to enable shareable deep links.
 *
 * The auth hook receives the Hocuspocus `documentName` alongside the
 * session token, so we parse the project UUID out of the name and
 * hit the `projects` table to verify ownership before returning the
 * user context.
 */

import type Redis from "ioredis";
import postgres from "postgres";
import { DEV_USER_ID } from "@breatic/shared";

/** Resolved user context from authentication. */
export interface AuthContext {
  user: {
    id: string;
  };
}

/**
 * Parse a Hocuspocus document name and return the project UUID it
 * refers to, or `null` if the name does not match the expected
 * canvas / node-editor patterns.
 *
 * Recognized formats:
 *
 *   - `project-<uuid>/canvas`
 *   - `project-<uuid>/node/<nodeId>`
 *
 * The UUID check uses a tolerant regex (hex + dashes, 36 chars)
 * rather than the strict RFC 4122 variant so that test fixtures
 * using non-v4 UUIDs still parse.
 */
function parseProjectIdFromDocName(documentName: string): string | null {
  // project-<uuid>/<rest>
  const match = documentName.match(
    /^project-([0-9a-fA-F-]{36})\/(canvas|node\/.+)$/,
  );
  if (!match) return null;
  return match[1]!;
}

/**
 * Options required to build the auth hook. The Postgres connection
 * is used for project ownership lookups and is pooled (`max: 5`).
 */
export interface CreateAuthHookOptions {
  redis: Redis;
  envPrefix: string;
  databaseUrl: string;
}

/**
 * Create the onAuthenticate hook for Hocuspocus.
 *
 * Performs two checks before the client is allowed to open or
 * subscribe to a document:
 *
 *   1. The supplied session token resolves to a user id in Redis.
 *   2. The `documentName` encodes a project UUID the user owns
 *      (enforced by a SQL query that joins projects on user_id and
 *      filters soft-deleted rows).
 *
 * Documents whose name does not match the expected project pattern
 * are rejected outright so that arbitrary string document names
 * cannot bypass the project check in the future.
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
    // NoAccount mode: skip auth, use dev user (dev/test only).
    if (process.env.LOGIN_MODE === "NoAccount") {
      if (process.env.ENV === "prod") {
        throw new Error("NoAccount mode forbidden in production");
      }
      return { user: { id: DEV_USER_ID } };
    }

    if (!token) {
      throw new Error("No authentication token provided");
    }

    const userId = await redis.get(`${envPrefix}:session:${token}`);
    if (!userId) {
      throw new Error("Invalid or expired session token");
    }

    const projectId = parseProjectIdFromDocName(documentName);
    if (!projectId) {
      throw new Error(
        `Document '${documentName}' is not in a recognized project format`,
      );
    }

    const rows = await sql<{ id: string }[]>`
      SELECT id
      FROM projects
      WHERE id = ${projectId}
        AND user_id = ${userId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error(
        `User ${userId} is not authorized to access project ${projectId}`,
      );
    }

    return {
      user: { id: userId },
    };
  };
}
