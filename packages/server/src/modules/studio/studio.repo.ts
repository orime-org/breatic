// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio repository — `studios` table data access.
 *
 * A studio is `personal` (one per user, created at the slug-setup
 * onboarding step) or `team`. The slug (URL handle) is globally unique and
 * chosen by the user. "One personal studio per user" is enforced by the
 * `studios_owner_personal_idx` partial unique index; a taken handle by
 * `studios_slug_idx`.
 */

import { and, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { studios } from "@breatic/core";
import type { Studio, StudioType } from "@breatic/shared";

/**
 * Map a Drizzle studio row to the shared `Studio` domain entity.
 * @param row - Raw studio row selected from the `studios` table.
 * @returns The mapped `Studio` domain entity.
 */
function toEntity(row: typeof studios.$inferSelect): Studio {
  return {
    id: row.id,
    createdByUserId: row.createdByUserId,
    slug: row.slug,
    type: row.type as StudioType,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Look up a user's active **personal** studio (one per user).
 * @param createdByUserId - User UUID
 * @returns The personal studio entity, or `null` if none exists
 */
export async function getPersonalByCreator(
  createdByUserId: string,
): Promise<Studio | null> {
  const rows = await db
    .select()
    .from(studios)
    .where(
      and(
        eq(studios.createdByUserId, createdByUserId),
        eq(studios.type, "personal"),
        isNull(studios.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Insert a personal studio (slug = name = the chosen handle).
 *
 * Caller must ensure no active personal studio exists for the user (the
 * `studios_owner_personal_idx` partial unique index rejects duplicates;
 * `studios_slug_idx` rejects a taken handle). Accepts an optional Drizzle
 * transaction so setup-studio can create the studio + the creator's admin
 * member row in one atomic operation.
 * @param createdByUserId - The creator's user UUID
 * @param slug - The user's URL handle; also the studio's slug
 * @param name - Display name (initially the slug)
 * @param tx - Optional transaction handle
 * @returns The freshly created studio entity
 */
export async function createPersonalStudio(
  createdByUserId: string,
  slug: string,
  name: string,
  tx?: DbTx,
): Promise<Studio> {
  const runner = tx ?? db;
  const rows = await runner
    .insert(studios)
    .values({ createdByUserId, slug, name, type: "personal" })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Batch-resolve each user's active personal studio `name`.
 *
 * Backs display-name lookup for `/users` batch + invite `inviterName`
 * (the name moved off `users` to the personal studio). Users with no
 * active personal studio are absent from the map; callers fall back to
 * the email local-part.
 * @param createdByUserIds - User UUIDs to resolve (empty input → empty map)
 * @returns Map of `userId → personal studio name`
 */
export async function getPersonalNamesByCreators(
  createdByUserIds: string[],
): Promise<Map<string, string>> {
  if (createdByUserIds.length === 0) return new Map();
  const rows = await db
    .select({ createdByUserId: studios.createdByUserId, name: studios.name })
    .from(studios)
    .where(
      and(
        inArray(studios.createdByUserId, createdByUserIds),
        eq(studios.type, "personal"),
        isNull(studios.deletedAt),
      ),
    );
  return new Map(rows.map((r) => [r.createdByUserId, r.name]));
}
