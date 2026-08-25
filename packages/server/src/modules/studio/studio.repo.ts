// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Studio repository — `studios` table data access.
 *
 * A studio is `personal` (one per user, created at the slug-setup
 * onboarding step) or `team`. The slug (URL handle) is globally unique and
 * chosen by the user. "One personal studio per user" is enforced by the
 * `studios_owner_personal_idx` partial unique index; a taken handle by
 * `studios_slug_idx`.
 */

import { and, eq, ne, isNull, inArray, sql } from "drizzle-orm";
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
 * Take the studio's own row for the rest of the transaction.
 *
 * This is what serialises the checks against anything a studio holds a fixed
 * number of — projects and members today (#86, #87). The other two ceilings
 * are not serialised here and do not need to be: concurrent writable
 * connections are counted in collab's own cross-instance registry (#88), and
 * storage is a soft pre-check that is deliberately allowed to overshoot
 * (#89). Counting rows and then inserting
 * is not a decision under concurrency: two transactions both count, both see
 * room, and both insert. Measured on the account-level ceiling in block one —
 * three simultaneous requests against a ceiling of one left two rows behind.
 *
 * The row to take is the one the COUNTED SET belongs to, which is not always
 * the row the tier is read from. Both happen to be the account row when the
 * set is "team studios this account administers", and that coincidence is why
 * the rule was easy to get wrong: applied to a per-studio set it would take
 * the admin's account row and make every studio that person administers queue
 * against every other. Two studios take two different rows and never wait on
 * each other.
 *
 * Deliberately does not filter `deleted_at`: this only serialises, and a
 * caller that cares whether the studio is alive says so itself. Adding the
 * predicate here would make the lock silently no-op on the row a concurrent
 * delete is in the middle of soft-deleting.
 * @param studioId - The studio whose row to lock
 * @param tx - The enclosing transaction; the lock is meaningless without one
 * @returns `true` when a row with that id exists and is now locked
 */
export async function lockStudio(studioId: string, tx: DbTx): Promise<boolean> {
  const rows = await tx
    .select({ id: studios.id })
    .from(studios)
    .where(eq(studios.id, studioId))
    .for("update")
    .limit(1);
  return rows.length > 0;
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
 * Batch-resolve each user's personal studio `name` + URL `slug` (handle).
 *
 * Backs the bell notification actor identity: the slug is both the `@handle`
 * shown beside the name and the `/studio/{slug}` link target.
 *
 * Soft-deleted studios ARE returned, flagged `deleted`, because a notification
 * is a record of something that happened and "someone invited you" with the
 * someone missing is not a usable record. Callers keep the name and drop only
 * the link. Users with no personal studio at all (mid-onboarding) are absent
 * from the map; callers fall back.
 *
 * A live row always wins over a soft-deleted one. Without the active-only
 * filter a user can match more than one row, and the query has no ordering —
 * so building the map by last-write-wins would pick an arbitrary row and could
 * show a stale name for someone who is perfectly present.
 * A caller inside a transaction MUST pass the handle. Both `confirmInvite`
 * transactions call this while holding a `studios` / `projects` row lock, and a
 * read issued without the handle reaches for a second pooled connection while
 * the first is still held — which is how a pool exhausts itself under
 * concurrent writes, in a shape that does not recover: the connection the lock
 * holder cannot get is the one it needs before it can commit and let go.
 * @param createdByUserIds - User UUIDs to resolve (empty input → empty map)
 * @param tx - Enclosing transaction, when the caller is inside one
 * @returns Map of `userId → { name, slug, deleted }`
 */
export async function getPersonalProfilesByCreators(
  createdByUserIds: string[],
  tx?: DbTx,
): Promise<Map<string, { name: string; slug: string; deleted: boolean }>> {
  if (createdByUserIds.length === 0) return new Map();
  const rows = await (tx ?? db)
    .select({
      createdByUserId: studios.createdByUserId,
      name: studios.name,
      slug: studios.slug,
      deletedAt: studios.deletedAt,
    })
    .from(studios)
    .where(
      and(
        inArray(studios.createdByUserId, createdByUserIds),
        eq(studios.type, "personal"),
      ),
    );
  const byUser = new Map<
    string,
    { name: string; slug: string; deleted: boolean }
  >();
  for (const row of rows) {
    const held = byUser.get(row.createdByUserId);
    if (held !== undefined && !held.deleted) continue;
    byUser.set(row.createdByUserId, {
      name: row.name,
      slug: row.slug,
      deleted: row.deletedAt !== null,
    });
  }
  return byUser;
}

/**
 * Resolve studio ids to their CURRENT name + slug, in one query.
 *
 * The read half of storing ids instead of names. Notifications keep the id
 * and look the display identity up at render time, so a studio that has been
 * renamed — or whose slug has been released and re-claimed by somebody else —
 * still resolves to the right place.
 *
 * Soft-deleted studios ARE returned, flagged `deleted`. Soft delete is
 * deactivation, not erasure — the caller keeps naming the target while
 * dropping its link. Erasure is a separate path that anonymises the row
 * itself, at which point this returns the anonymised value with no special
 * case here. Only a studio that never existed is absent.
 * @param studioIds - Studio UUIDs (deduped by the caller)
 * @returns Map of `studioId → { name, slug, deleted }`
 */
export async function getIdentitiesByStudioIds(
  studioIds: string[],
): Promise<Map<string, { name: string; slug: string; deleted: boolean }>> {
  if (studioIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: studios.id,
      name: studios.name,
      slug: studios.slug,
      deletedAt: studios.deletedAt,
    })
    .from(studios)
    .where(inArray(studios.id, studioIds));
  return new Map(
    rows.map((r) => [
      r.id,
      { name: r.name, slug: r.slug, deleted: r.deletedAt !== null },
    ]),
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
 * Is this slug claimed by an active studio OTHER than the given one?
 *
 * The exclusion is what makes the rename form usable: a studio's current slug
 * is of course "taken" — by itself — so a check without it tells an admin
 * their own handle is unavailable the moment they focus the field. Creation
 * passes no exclusion and behaves exactly as before.
 *
 * Advisory only. The authoritative guard is the `studios_slug_idx` unique
 * index at write time, so a slug reported free here can still lose a
 * concurrent race and surface as a conflict on submit.
 * @param slug - The candidate slug
 * @param excludeStudioId - A studio whose own claim on the slug does not count
 * @returns true when some other active studio already holds it
 */
export async function isSlugTaken(
  slug: string,
  excludeStudioId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: studios.id })
    .from(studios)
    .where(
      and(
        eq(studios.slug, slug),
        isNull(studios.deletedAt),
        excludeStudioId ? ne(studios.id, excludeStudioId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Apply a settings patch to a studio — display name, slug, bio, and/or avatar.
 *
 * Only the keys present in `patch` are written, so an absent field keeps its
 * current value. A `bio` or `avatarUrl` of `null` clears it; the service maps
 * an empty-string bio to `null` so the column has one representation of "no
 * bio".
 *
 * A slug collision surfaces as the unique-index violation rather than being
 * pre-checked here — the pre-check is advisory and racy, the index is not.
 * @param id - Studio UUID
 * @param patch - The fields to write (at least one)
 * @param patch.name - New display name
 * @param patch.slug - New URL handle
 * @param patch.bio - New bio, or `null` to clear it
 * @param patch.avatarUrl - New avatar URL, or `null` to fall back to initials
 * @returns The updated studio, or `null` if it is missing / soft-deleted
 */
export async function updateStudio(
  id: string,
  patch: {
    name?: string;
    slug?: string;
    bio?: string | null;
    avatarUrl?: string | null;
  },
): Promise<Studio | null> {
  const rows = await db
    .update(studios)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(studios.id, id), isNull(studios.deletedAt)))
    .returning();
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Load a studio by its id (active only) — used where the caller already holds
 * a studio id (e.g. a project's `studioId`) and needs the studio's `type`.
 * @param id - Studio UUID
 * @param tx - Enclosing transaction, when the caller is inside one; a read
 *   issued from inside a transaction without it reaches for a second pooled
 *   connection while the first is still held
 * @returns The studio, or `null` if missing / soft-deleted
 */
export async function getById(
  id: string,
  tx?: DbTx,
): Promise<Studio | null> {
  const rows = await (tx ?? db)
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
 * Backs `memberCount` for the container shell + switcher, and the per-studio
 * member ceiling. A studio with no active members is simply absent from the map
 * (callers default to 0).
 *
 * A caller inside a transaction MUST pass the handle. Not for correctness —
 * the gate holds the `studios` row by then, so no other confirm can have an
 * uncommitted insert in flight — but because a read issued without it reaches
 * for a second pooled connection while the first is still held, which is how a
 * pool exhausts itself under concurrent writes. Worse here than elsewhere: the
 * connection it cannot get is one the lock holder needs before it can release
 * the lock, so everybody queued behind it waits too.
 * @param studioIds - Studio UUIDs to count (empty input → empty map)
 * @param tx - Enclosing transaction, when the caller is inside one
 * @returns Map of `studioId → active member count`
 */
export async function countMembersByStudioIds(
  studioIds: string[],
  tx?: DbTx,
): Promise<Map<string, number>> {
  if (studioIds.length === 0) return new Map();
  const rows = await (tx ?? db)
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
