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

import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { studioMembers, studios, users } from "@breatic/core";
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

/**
 * List a studio's active members with display fields, for the Members tab.
 *
 * Backs `GET /studio/:slug/members`. Joins each member to `users` for `email`
 * and to that user's personal studio for the display `name` + `avatar` — a
 * user's display name and avatar both live on their personal studio (there is
 * no `users.username`, and `users.avatar_url` moved to the studio in #1808).
 * Soft-deleted members are excluded; ordered oldest-first (`addedAt`) so the
 * admin/creator appears at the top.
 * @param studioId - Studio UUID
 * @returns Active members: userId, email, display name, avatar, role, joinedAt
 */
export async function listByStudio(
  studioId: string,
): Promise<
  ReadonlyArray<{
    userId: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    role: StudioRole;
    addedAt: Date;
  }>
> {
  const rows = await db
    .select({
      userId: studioMembers.userId,
      email: users.email,
      name: studios.name,
      avatarUrl: studios.avatarUrl,
      role: studioMembers.role,
      addedAt: studioMembers.addedAt,
    })
    .from(studioMembers)
    .innerJoin(users, eq(users.id, studioMembers.userId))
    .leftJoin(
      studios,
      and(
        eq(studios.createdByUserId, studioMembers.userId),
        eq(studios.type, "personal"),
        isNull(studios.deletedAt),
      ),
    )
    .where(
      and(eq(studioMembers.studioId, studioId), isNull(studioMembers.deletedAt)),
    )
    .orderBy(studioMembers.addedAt);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name ?? r.email,
    avatarUrl: r.avatarUrl,
    role: r.role as StudioRole,
    addedAt: r.addedAt,
  }));
}

/**
 * Invite (upsert) a member — insert a fresh active row, revive a soft-deleted
 * one, or reject a re-invite of an already-active member.
 *
 * ON CONFLICT (studio_id, user_id): a missing row inserts; a soft-deleted row
 * (previously kicked) is revived with the new role + inviter (`setWhere
 * deleted_at IS NOT NULL`); an ALREADY-active row does not match `setWhere`,
 * so the UPDATE is skipped, RETURNING is empty → returns false (caller maps to
 * ConflictError; no silent role overwrite). `role` is expected to be
 * 'maintainer' | 'guest' — admin is granted via transfer, never invite; the
 * caller enforces that. Mirrors `materializeBaselineViewer`'s revive pattern.
 * @param studioId - Studio UUID
 * @param userId - The invitee's user UUID
 * @param role - Granted studio role (maintainer | guest)
 * @param addedBy - The inviting admin's user UUID
 * @param tx - Optional drizzle transaction handle
 * @returns true if a row was inserted or revived; false if already active
 */
export async function upsertMember(
  studioId: string,
  userId: string,
  role: StudioRole,
  addedBy: string,
  tx?: DbTx,
): Promise<boolean> {
  const handle = tx ?? db;
  const rows = await handle
    .insert(studioMembers)
    .values({ studioId, userId, role, addedBy })
    .onConflictDoUpdate({
      target: [studioMembers.studioId, studioMembers.userId],
      set: { role, addedBy, deletedAt: null },
      setWhere: isNotNull(studioMembers.deletedAt),
    })
    .returning({ userId: studioMembers.userId });
  return rows.length > 0;
}

/**
 * Read a member's role **inside a transaction, holding a row lock** on that
 * member row.
 *
 * Distinct from `getRole`, which is the unlocked read used by route-level
 * role resolution. A membership mutation that decides based on `getRole`
 * acts on a snapshot from outside its own transaction: a concurrent admin
 * transfer can commit in between, and the mutation then soft-deletes the row
 * that just became admin — leaving the studio with zero admins and no way
 * back. Locking the row makes the concurrent writer queue instead of
 * interleaving.
 *
 * `FOR UPDATE OF studio_members` locks only this table; the `studios` join
 * is a liveness guard, and locking studio rows would serialise unrelated
 * membership work across the whole studio.
 *
 * For one member's row this narrow lock is sound, because the condition names
 * no column a concurrent writer rewrites: a role change leaves
 * `user_id`/`deleted_at` alone, so the re-check after waiting still matches
 * and the caller sees the NEW role. Anything that has to reason about the
 * studio's admin must use {@link lockMembership} instead — see there for why
 * filtering on `role` breaks under concurrency.
 *
 * **Ordering across tables: `studios` → `studio_members` → `studio_credit_debts`
 * → `credit_lots`, with `project_members` a leaf off `studio_members`.**
 * Leaving locks membership first and then writes project rows; designating
 * takes this row, then the studio's debt, then the lot; a caller that took any
 * of those first would deadlock against them.
 *
 * **One edge runs the other way**: writing a non-null designation makes the
 * database confirm the parent studio exists, which locks that `studios` row
 * after this one has already been taken. Nothing reaches it today — the only
 * path holding a `studios` row before a membership row is accepting an invite,
 * and the membership row it then writes belongs to the invitee while this one
 * belongs to whoever is designating. Building studio deletion (#26) puts a
 * `studios` → `credit_lots` writer in the same picture and has to weigh that
 * edge again.
 * @param studioId - Studio UUID
 * @param userId - User UUID
 * @param tx - The enclosing transaction; the lock is meaningless without one
 * @returns Role, or null if the studio is missing/deleted or the user has no
 *   active membership
 */
export async function lockMemberRole(
  studioId: string,
  userId: string,
  tx: DbTx,
): Promise<StudioRole | null> {
  const rows = await tx
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
    .for("update", { of: studioMembers })
    .limit(1);
  return rows[0] ? (rows[0].role as StudioRole) : null;
}

/**
 * Lock and return every active member of a studio — the serialisation point
 * for any change that has to keep "exactly one admin" true.
 *
 * Takes the whole membership rather than the two rows a caller happens to
 * care about, and that is the point: **the search condition must not mention
 * a column the concurrent writer changes.** Under READ COMMITTED, a
 * `SELECT ... FOR UPDATE` that blocks re-checks its condition against the
 * UPDATED row once the lock frees, and skips the row if it no longer matches
 * — without restarting the scan to find whoever matches now. So a query
 * filtered on `role = 'admin'` returns EMPTY exactly when it matters most:
 * while the admin role is mid-handover, having waited for that handover and
 * then decided the studio has no admin at all. Filtering only on `studio_id`
 * and `deleted_at` leaves nothing for a role change to invalidate; the caller
 * finds the admin in the returned rows, which are the post-wait truth.
 *
 * A member row can still vanish from the result — soft delete makes
 * `deleted_at IS NULL` fail on re-check — and that is correct: a member
 * removed while we waited really is gone.
 *
 * Locking every row also removes the ordering question inside this table.
 * Two callers issuing the same query acquire the same rows in the same
 * order, so they queue instead of deadlocking, and no caller has to reason
 * about which of the admin row and the target row to take first.
 *
 * **Ordering across tables still holds: `studios` → `studio_members` →
 * `studio_credit_debts` → `credit_lots`, with `project_members` a leaf off
 * `studio_members`.** Leaving locks the membership here and then writes
 * project rows; accepting a transfer locks it here and then releases the
 * outgoing admin's credit lots. A path that took a project row or a lot first
 * would deadlock against them.
 * @param studioId - Studio UUID
 * @param tx - The enclosing transaction; the lock is meaningless without one
 * @returns Every active member of an active studio; empty when the studio is
 *   missing or soft-deleted
 */
export async function lockMembership(
  studioId: string,
  tx: DbTx,
): Promise<ReadonlyArray<{ userId: string; role: StudioRole }>> {
  const rows = await tx
    .select({ userId: studioMembers.userId, role: studioMembers.role })
    .from(studioMembers)
    .innerJoin(studios, eq(studios.id, studioMembers.studioId))
    .where(
      and(
        eq(studioMembers.studioId, studioId),
        isNull(studioMembers.deletedAt),
        isNull(studios.deletedAt),
      ),
    )
    .for("update", { of: studioMembers });
  return rows.map((r) => ({ userId: r.userId, role: r.role as StudioRole }));
}

/**
 * Soft-delete (remove / kick) an active member — state-only.
 *
 * Flips `deleted_at` on the active row; the row physically remains (soft
 * delete is the only deletion mode). Returns false when there is no active row
 * (non-member or already removed), so the caller distinguishes success from
 * NotFound without a separate read.
 * @param studioId - Studio UUID
 * @param userId - The member's user UUID
 * @param tx - Optional drizzle transaction handle
 * @returns true if an active row was soft-deleted; false otherwise
 */
export async function softDelete(
  studioId: string,
  userId: string,
  tx?: DbTx,
): Promise<boolean> {
  const handle = tx ?? db;
  const rows = await handle
    .update(studioMembers)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(studioMembers.studioId, studioId),
        eq(studioMembers.userId, userId),
        isNull(studioMembers.deletedAt),
      ),
    )
    .returning({ userId: studioMembers.userId });
  return rows.length > 0;
}

/**
 * Update an active member's role — backs change-role (maintainer↔guest) and the
 * two same-tx steps of transfer-admin (demote old admin, promote new).
 *
 * Only touches the active row. Bumping to 'admin' while another active admin
 * exists hits the `studio_members_one_admin_per_studio` partial unique
 * (throws) — transfer MUST demote the old admin first in the same tx. Returns
 * false when there is no active row (NotFound).
 * @param studioId - Studio UUID
 * @param userId - The member's user UUID
 * @param role - New studio role
 * @param tx - Optional drizzle transaction handle
 * @returns true if an active row's role was updated; false otherwise
 */
export async function updateRole(
  studioId: string,
  userId: string,
  role: StudioRole,
  tx?: DbTx,
): Promise<boolean> {
  const handle = tx ?? db;
  const rows = await handle
    .update(studioMembers)
    .set({ role })
    .where(
      and(
        eq(studioMembers.studioId, studioId),
        eq(studioMembers.userId, userId),
        isNull(studioMembers.deletedAt),
      ),
    )
    .returning({ userId: studioMembers.userId });
  return rows.length > 0;
}
