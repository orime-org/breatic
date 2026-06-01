/**
 * Studio repository — V1 personal studio data access.
 *
 * Every user has exactly one personal studio (V1 invariant, enforced
 * by `studios_owner_user_id_idx` partial unique index). The repo
 * exposes lookup-by-owner and idempotent create.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@breatic/core";
import { studios } from "@breatic/core";
import type { Studio } from "@breatic/shared";
import type { DbTx } from "@server/modules/conversation/conversation.repo.js";

function toEntity(row: typeof studios.$inferSelect): Studio {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Look up a user's active personal studio.
 *
 * @param ownerUserId - User UUID
 * @returns The studio entity, or `null` if none exists
 */
export async function getByOwnerUserId(
  ownerUserId: string,
): Promise<Studio | null> {
  const rows = await db
    .select()
    .from(studios)
    .where(and(eq(studios.ownerUserId, ownerUserId), isNull(studios.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Insert a new personal studio for the given owner.
 *
 * Caller must ensure no active studio exists for the user (the partial
 * unique index will reject duplicates). Use {@link getByOwnerUserId}
 * first if you need an idempotent ensure flow.
 *
 * Accepts an optional Drizzle transaction so register flows can
 * create the user + studio + (later) project_members owner row in
 * one atomic operation.
 *
 * @param ownerUserId - User UUID
 * @param name - Display name (e.g. `"{username}'s Studio"`)
 * @param tx - Optional transaction handle
 * @returns The freshly created studio entity
 */
export async function createPersonalStudio(
  ownerUserId: string,
  name: string,
  tx?: DbTx,
): Promise<Studio> {
  const runner = tx ?? db;
  const rows = await runner
    .insert(studios)
    .values({ ownerUserId, name })
    .returning();
  return toEntity(rows[0]!);
}
