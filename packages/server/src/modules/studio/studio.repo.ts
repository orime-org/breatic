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

import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { studios, studioMembers } from "@breatic/core";
import type { Studio, StudioRole, StudioType } from "@breatic/shared";

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
    avatarUrl: row.avatarUrl,
    bio: row.bio,
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
 * Insert a team studio (name and slug are independent; `type='team'`).
 *
 * Unlike a personal studio (one per user), a user may own many team studios —
 * the `studios_owner_personal_idx` partial unique index is scoped to
 * `type='personal'`, so team rows are unconstrained on creator. The
 * global-unique slug index (`studios_slug_idx`) still rejects a taken handle.
 * Accepts an optional transaction so the service can create the studio + the
 * creator's admin member row atomically.
 * @param createdByUserId - The creator's user UUID (becomes the studio admin)
 * @param slug - The globally-unique URL handle
 * @param name - The display name (independent of the slug)
 * @param tx - Optional transaction handle
 * @returns The freshly created team studio entity
 */
export async function createTeamStudio(
  createdByUserId: string,
  slug: string,
  name: string,
  tx?: DbTx,
): Promise<Studio> {
  const runner = tx ?? db;
  const rows = await runner
    .insert(studios)
    .values({ createdByUserId, slug, name, type: "team" })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * List the ids of the team studios a user **currently administers**.
 *
 * Scoped to `type='team'` + a current `admin` `studio_members` row — NOT the
 * immutable `created_by_user_id`. A studio's ownership is its current admin
 * (admin can be transferred), so the set must follow the current role: a
 * creator who transfers all their studios away drops out, and a recipient's
 * set fills up. This honours the project rule that mutable ownership is decided
 * by `studio_members.role`, never by the immutable audit field. Personal studios
 * and soft-deleted rows (studio or membership) are excluded. This is the single
 * source of truth for "administered team studios" — {@link countTeamStudiosAdministeredBy}
 * (the per-user creation quota) and the account storage roll-up (#1826 §5.3)
 * both derive from it, so their predicates can never drift apart. Accepts an
 * optional transaction so it can run inside a create transaction.
 * @param userId - The user UUID whose administered team studios to enumerate
 * @param tx - Optional transaction handle
 * @returns The ids of the active team studios the user currently administers
 */
export async function listTeamStudioIdsAdministeredBy(
  userId: string,
  tx?: DbTx,
): Promise<string[]> {
  const runner = tx ?? db;
  const rows = await runner
    .select({ id: studios.id })
    .from(studios)
    .innerJoin(studioMembers, eq(studioMembers.studioId, studios.id))
    .where(
      and(
        eq(studioMembers.userId, userId),
        eq(studioMembers.role, "admin"),
        isNull(studioMembers.deletedAt),
        eq(studios.type, "team"),
        isNull(studios.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Count the team studios a user **currently administers** (for the per-user
 * creation limit). Delegates to {@link listTeamStudioIdsAdministeredBy} so the
 * quota and the account roll-up share one ownership predicate (the count can
 * never diverge from the enumeration). The administered set is bounded by the
 * per-user cap, so materialising the ids to count them is negligible.
 * @param userId - The user UUID whose administered team studios to count
 * @param tx - Optional transaction handle
 * @returns The number of active team studios the user currently administers
 */
export async function countTeamStudiosAdministeredBy(
  userId: string,
  tx?: DbTx,
): Promise<number> {
  return (await listTeamStudioIdsAdministeredBy(userId, tx)).length;
}

/**
 * Batch-resolve each user's active personal studio identity (`name` +
 * `avatarUrl`).
 *
 * Backs the `/users` batch display-info endpoint — the display name and
 * avatar both live on the personal studio (pointer model; avatar moved off
 * `users` 2026-07-22, #1808). Users with no active personal studio are
 * absent from the map; callers fall back to the email local-part (and a
 * null avatar).
 * @param createdByUserIds - User UUIDs to resolve (empty input → empty map)
 * @returns Map of `userId → { name, avatarUrl }`
 */
export async function getPersonalIdentitiesByCreators(
  createdByUserIds: string[],
): Promise<Map<string, { name: string; avatarUrl: string | null }>> {
  if (createdByUserIds.length === 0) return new Map();
  const rows = await db
    .select({
      createdByUserId: studios.createdByUserId,
      name: studios.name,
      avatarUrl: studios.avatarUrl,
    })
    .from(studios)
    .where(
      and(
        inArray(studios.createdByUserId, createdByUserIds),
        eq(studios.type, "personal"),
        isNull(studios.deletedAt),
      ),
    );
  return new Map(
    rows.map((r) => [r.createdByUserId, { name: r.name, avatarUrl: r.avatarUrl }]),
  );
}

/**
 * Batch-resolve each user's active personal studio `name` + URL `slug` (handle).
 *
 * Backs the bell notification actor identity: the slug is both the `@handle`
 * shown beside the name and the `/studio/{slug}` link target. Users with no
 * active personal studio (mid-onboarding) are absent from the map; callers
 * fall back.
 * @param createdByUserIds - User UUIDs to resolve (empty input → empty map)
 * @returns Map of `userId → { name, slug }`
 */
export async function getPersonalProfilesByCreators(
  createdByUserIds: string[],
): Promise<Map<string, { name: string; slug: string }>> {
  if (createdByUserIds.length === 0) return new Map();
  const rows = await db
    .select({
      createdByUserId: studios.createdByUserId,
      name: studios.name,
      slug: studios.slug,
    })
    .from(studios)
    .where(
      and(
        inArray(studios.createdByUserId, createdByUserIds),
        eq(studios.type, "personal"),
        isNull(studios.deletedAt),
      ),
    );
  return new Map(
    rows.map((r) => [r.createdByUserId, { name: r.name, slug: r.slug }]),
  );
}

/**
 * Look up an active studio (personal or team) by its URL handle.
 *
 * Backs the container shell (`GET /studio/:slug`). The slug is globally
 * unique among active studios (`studios_slug_idx`), so at most one row
 * matches.
 * @param slug - The studio's globally-unique slug
 * @returns The studio entity, or `null` if no active studio has that slug
 */
export async function getBySlug(slug: string): Promise<Studio | null> {
  const rows = await db
    .select()
    .from(studios)
    .where(and(eq(studios.slug, slug), isNull(studios.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Load a studio by its id (active only) — used where the caller already holds
 * a studio id (e.g. a project's `studioId`) and needs the studio's `type`.
 * @param id - Studio UUID
 * @returns The studio, or `null` if missing / soft-deleted
 */
export async function getById(id: string): Promise<Studio | null> {
  const rows = await db
    .select()
    .from(studios)
    .where(and(eq(studios.id, id), isNull(studios.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * List every active studio the user is an active member of, oldest first.
 *
 * Joins `studio_members` → `studios`, hiding soft-deleted memberships and
 * soft-deleted studios. Ordered by `created_at` ascending; the
 * personal-first sort the switcher needs is applied by the service layer.
 * @param userId - The user UUID whose memberships to resolve
 * @returns The user's studios + the viewer's current role in each, oldest first
 */
export async function listByUser(
  userId: string,
): Promise<Array<Studio & { myStudioRole: StudioRole }>> {
  const rows = await db
    .select({ studio: studios, role: studioMembers.role })
    .from(studioMembers)
    .innerJoin(studios, eq(studios.id, studioMembers.studioId))
    .where(
      and(
        eq(studioMembers.userId, userId),
        isNull(studioMembers.deletedAt),
        isNull(studios.deletedAt),
      ),
    )
    .orderBy(studios.createdAt);
  return rows.map((r) => ({
    ...toEntity(r.studio),
    myStudioRole: r.role as StudioRole,
  }));
}

/**
 * Count active members per studio in one grouped query (avoids N+1).
 *
 * Backs `memberCount` for the container shell + switcher. A studio with no
 * active members is simply absent from the map (callers default to 0).
 * @param studioIds - Studio UUIDs to count (empty input → empty map)
 * @returns Map of `studioId → active member count`
 */
export async function countMembersByStudioIds(
  studioIds: string[],
): Promise<Map<string, number>> {
  if (studioIds.length === 0) return new Map();
  const rows = await db
    .select({
      studioId: studioMembers.studioId,
      count: sql<number>`count(*)::int`,
    })
    .from(studioMembers)
    .where(
      and(
        inArray(studioMembers.studioId, studioIds),
        isNull(studioMembers.deletedAt),
      ),
    )
    .groupBy(studioMembers.studioId);
  return new Map(rows.map((r) => [r.studioId, r.count]));
}
