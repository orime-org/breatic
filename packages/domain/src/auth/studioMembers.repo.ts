// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio members repository — `studio_members` table CRUD.
 *
 * Studio-level permission state lives in PG (mirrors `projectMembers`).
 * This repo is the single source of truth for who has what studio role.
 * One active admin per studio is enforced by a partial unique index
 * (`studio_members_one_admin_per_studio`); writers do not check it
 * client-side. Soft delete is the only deletion mode.
 *
 * Lives in `@breatic/domain` (not `@breatic/core`): studio membership is
 * used by server + worker (e.g. billing_source needs to know whether the
 * actor is a studio member), but collab never touches it — collab's
 * `onAuthenticate` reads `project_members` only. (Contrast
 * `projectMembers.repo`, which is in core because collab uses it.)
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { studioMembers, studios } from "@breatic/core";
import type { StudioRole } from "@breatic/shared";

/**
 * Get the active studio role for a user on an **active** studio, or null.
 *
 * The single source of truth for "what studio-level role does this user
 * have", consumed by `loadStudioRole`. Both null branches — studio
 * missing/soft-deleted, and user-not-a-member — collapse to `null`. The
 * `studios` inner-join with `deleted_at IS NULL` folds the studio-active
 * guard into the same query (no separate existence SELECT, no raw `db`
 * access outside this repo).
 * @param studioId - Studio UUID
 * @param userId - User UUID
 * @returns Role, or null if the studio is missing/deleted or the user
 *   has no active membership
 */
export async function getRole(
  studioId: string,
  userId: string,
): Promise<StudioRole | null> {
  const rows = await db
    .select({ role: studioMembers.role })
    .from(studioMembers)
    .innerJoin(studios, eq(studios.id, studioMembers.studioId))
    .where(
      and(
        eq(studioMembers.studioId, studioId),
        eq(studioMembers.userId, userId),
        isNull(studioMembers.deletedAt),
        isNull(studios.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? (rows[0].role as StudioRole) : null;
}

/**
 * Insert the admin row for a freshly created studio.
 *
 * `addedBy` is null because the creator has no inviter. Must run in the
 * same transaction as the studio insert (mirrors `insertOwner` for
 * projects); the caller passes the `tx` handle. The "one active admin
 * per studio" partial unique index rejects a second active admin.
 * @param studioId - Studio UUID
 * @param userId - The creator's user UUID
 * @param tx - Optional drizzle transaction handle
 */
export async function insertAdmin(
  studioId: string,
  userId: string,
  tx?: DbTx,
): Promise<void> {
  const handle = tx ?? db;
  await handle.insert(studioMembers).values({
    studioId,
    userId,
    role: "admin",
    addedBy: null,
  });
}
