// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio invitations repository — `studio_invitations` table CRUD + the accept
 * / decline / revoke CAS operations (invite-confirm handshake, 2026-06-14).
 *
 * Pending studio-member invites live HERE, not as a status column on
 * `studio_members`, so `studio_members` stays "active members only" — studio
 * auth / member-count queries need zero filtering and a pending invitee can
 * never be mistaken for a real member (DD §2). Lives in `@server`: only the
 * server touches invites (worker / collab never do).
 *
 * Concurrency: `acceptIfPending` is a CAS (`UPDATE … WHERE status = 'pending'`)
 * — under concurrent confirms (bell + email link, or a double click) exactly
 * one UPDATE matches and returns a row; the rest return `null`. The same shape
 * backs decline / revoke. Soft delete is the only deletion mode; non-pending
 * and soft-deleted rows are treated as gone, so a previously declined /
 * expired / revoked invitee can be re-invited (a fresh pending row).
 *
 * Drizzle row types never leak past this repo (prohibition #3 /
 * lint:no-drizzle-type-leak): callers see the hand-written shapes below and
 * `PendingInvitationSummary` (a `@breatic/shared` entity).
 */

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, studioInvitations, studios, users } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { PendingInvitationSummary, StudioRole } from "@breatic/shared";

/** Roles an invite may grant — admin is granted via transfer, never invite. */
type InvitableRole = "creator" | "member";

/**
 * The membership-relevant fields of a just-accepted invite, returned by
 * {@link acceptIfPending} so the caller can write the `studio_members` row and
 * mark the bell notification read — all in the same transaction.
 */
export interface AcceptedInvite {
  studioId: string;
  invitedUserId: string;
  role: StudioRole;
  invitedBy: string;
  /** The bell notification to mark read (null when none was attached). */
  notificationId: string | null;
}

/**
 * Insert a fresh pending invitation; returns the new row id (the caller puts it
 * in the bell-notification payload, then links it back via
 * {@link attachNotification}).
 *
 * The `studio_invitations_one_pending` partial unique index rejects a second
 * LIVE pending for the same (studio, invitee) with SQLSTATE 23505 — the service
 * maps that to a ConflictError ("already invited"), no silent overwrite.
 * @param input - Studio, invitee, granted role, inviting admin, TTL, optional tx
 * @param input.studioId - The studio the invite is into
 * @param input.invitedUserId - The registered user being invited
 * @param input.role - Granted studio role (creator | member)
 * @param input.invitedBy - The inviting admin's user id
 * @param input.expiresAt - When the invite times out (matches the notification TTL)
 * @param input.tx - Optional drizzle transaction handle
 * @returns The new invitation's id
 * @throws {Error} if the insert returns no row (should never happen)
 */
export async function createPending(input: {
  studioId: string;
  invitedUserId: string;
  role: InvitableRole;
  invitedBy: string;
  expiresAt: Date;
  tx?: DbTx;
}): Promise<string> {
  const handle = input.tx ?? db;
  const rows = await handle
    .insert(studioInvitations)
    .values({
      studioId: input.studioId,
      invitedUserId: input.invitedUserId,
      role: input.role,
      invitedBy: input.invitedBy,
      status: "pending",
      expiresAt: input.expiresAt,
    })
    .returning({ id: studioInvitations.id });
  const row = rows[0];
  if (!row) {
    throw new Error("studioInvitationsRepo.createPending: insert returned no row");
  }
  return row.id;
}

/**
 * Link the bell notification to an invite (set right after the notification is
 * created, in the same transaction) so accept / decline / revoke can mark it
 * read and the bell entry disappears even when acted on via the email link.
 * @param id - Invitation id
 * @param notificationId - The `studio.invite_request` notification id
 * @param tx - Optional drizzle transaction handle
 */
export async function attachNotification(
  id: string,
  notificationId: string,
  tx?: DbTx,
): Promise<void> {
  const handle = tx ?? db;
  await handle
    .update(studioInvitations)
    .set({ notificationId })
    .where(eq(studioInvitations.id, id));
}

/**
 * Accept CAS — flip exactly one LIVE, non-expired pending invite owned by
 * `invitedUserId` to `accepted`, returning its membership fields.
 *
 * The `status = 'pending'` predicate is the serialization point: concurrent
 * confirms (bell + email, or a double click) race on the row, only the first
 * UPDATE matches, the rest return `null`. Expired pendings are excluded
 * (treated as void). The `invited_user_id` guard is defense-in-depth — only the
 * invitee can accept their own invite.
 * @param id - Invitation id
 * @param invitedUserId - The accepting user (must own the invite)
 * @param tx - Optional drizzle transaction handle (the confirm runs in a tx)
 * @returns The accepted invite's membership fields, or null if nothing matched
 */
export async function acceptIfPending(
  id: string,
  invitedUserId: string,
  tx?: DbTx,
): Promise<AcceptedInvite | null> {
  const handle = tx ?? db;
  const rows = await handle
    .update(studioInvitations)
    .set({ status: "accepted" })
    .where(
      and(
        eq(studioInvitations.id, id),
        eq(studioInvitations.invitedUserId, invitedUserId),
        eq(studioInvitations.status, "pending"),
        isNull(studioInvitations.deletedAt),
        gt(studioInvitations.expiresAt, sql`now()`),
      ),
    )
    .returning({
      studioId: studioInvitations.studioId,
      invitedUserId: studioInvitations.invitedUserId,
      role: studioInvitations.role,
      invitedBy: studioInvitations.invitedBy,
      notificationId: studioInvitations.notificationId,
    });
  const row = rows[0];
  if (!row) return null;
  return { ...row, role: row.role as StudioRole };
}

/**
 * Decline CAS — flip a LIVE pending invite owned by `invitedUserId` to
 * `declined`; the studio membership is untouched. Returns the attached
 * notification id (to mark read) or null when nothing matched (already decided
 * / not owned).
 * @param id - Invitation id
 * @param invitedUserId - The declining user (must own the invite)
 * @param tx - Optional drizzle transaction handle
 * @returns `{ notificationId }` of the declined invite, or null if none matched
 */
export async function declineIfPending(
  id: string,
  invitedUserId: string,
  tx?: DbTx,
): Promise<{ notificationId: string | null } | null> {
  const handle = tx ?? db;
  const rows = await handle
    .update(studioInvitations)
    .set({ status: "declined" })
    .where(
      and(
        eq(studioInvitations.id, id),
        eq(studioInvitations.invitedUserId, invitedUserId),
        eq(studioInvitations.status, "pending"),
        isNull(studioInvitations.deletedAt),
      ),
    )
    .returning({ notificationId: studioInvitations.notificationId });
  const row = rows[0];
  return row ? { notificationId: row.notificationId } : null;
}

/**
 * Revoke CAS — the admin cancels a LIVE pending invite in THEIR studio (the
 * `studio_id` guard ensures an admin can only revoke invites belonging to the
 * studio they administer). Returns the attached notification id + the invitee
 * id (so the caller can mark the invitee's bell notification read), or null.
 * @param id - Invitation id
 * @param studioId - The admin's studio (guard: the invite must belong to it)
 * @param tx - Optional drizzle transaction handle
 * @returns `{ notificationId, invitedUserId }` of the revoked invite, or null
 *   if none matched
 */
export async function revokeIfPending(
  id: string,
  studioId: string,
  tx?: DbTx,
): Promise<{ notificationId: string | null; invitedUserId: string } | null> {
  const handle = tx ?? db;
  const rows = await handle
    .update(studioInvitations)
    .set({ status: "revoked" })
    .where(
      and(
        eq(studioInvitations.id, id),
        eq(studioInvitations.studioId, studioId),
        eq(studioInvitations.status, "pending"),
        isNull(studioInvitations.deletedAt),
      ),
    )
    .returning({
      notificationId: studioInvitations.notificationId,
      invitedUserId: studioInvitations.invitedUserId,
    });
  const row = rows[0];
  return row
    ? { notificationId: row.notificationId, invitedUserId: row.invitedUserId }
    : null;
}

/**
 * List a studio's LIVE pending invitations with display fields, for the
 * Members tab's "invited (pending)" section.
 *
 * Mirrors `studioMembers.listByStudio`: joins the invitee to `users` (email,
 * avatar) and to their personal studio for the display `name`, plus the
 * inviter's personal studio for `invitedByName` (two `studios` aliases). Only
 * `status = 'pending'` and non-expired, non-deleted rows; newest first.
 * @param studioId - Studio UUID
 * @returns Pending invitations with display fields (empty when none)
 */
export async function listPendingByStudio(
  studioId: string,
): Promise<PendingInvitationSummary[]> {
  const inviteeStudio = alias(studios, "invitee_studio");
  const inviterStudio = alias(studios, "inviter_studio");
  const rows = await db
    .select({
      invitationId: studioInvitations.id,
      invitedUserId: studioInvitations.invitedUserId,
      name: inviteeStudio.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      role: studioInvitations.role,
      invitedByName: inviterStudio.name,
      expiresAt: studioInvitations.expiresAt,
    })
    .from(studioInvitations)
    .innerJoin(users, eq(users.id, studioInvitations.invitedUserId))
    .leftJoin(
      inviteeStudio,
      and(
        eq(inviteeStudio.createdByUserId, studioInvitations.invitedUserId),
        eq(inviteeStudio.type, "personal"),
        isNull(inviteeStudio.deletedAt),
      ),
    )
    .leftJoin(
      inviterStudio,
      and(
        eq(inviterStudio.createdByUserId, studioInvitations.invitedBy),
        eq(inviterStudio.type, "personal"),
        isNull(inviterStudio.deletedAt),
      ),
    )
    .where(
      and(
        eq(studioInvitations.studioId, studioId),
        eq(studioInvitations.status, "pending"),
        isNull(studioInvitations.deletedAt),
        gt(studioInvitations.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(studioInvitations.createdAt));
  return rows.map((r) => ({
    invitationId: r.invitationId,
    invitedUserId: r.invitedUserId,
    name: r.name ?? r.email,
    email: r.email,
    avatarUrl: r.avatarUrl,
    role: r.role as StudioRole,
    invitedByName: r.invitedByName ?? "",
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/**
 * Resolve a pending invite's landing-page detail by id (the email-link page
 * shows it before the invitee confirms). Joins the studio (name + slug) and the
 * inviter's personal studio (name). Includes EXPIRED pendings (the page renders
 * an "expired" state) — only non-pending / soft-deleted rows return null.
 * @param invitationId - Invitation id (resolved from the email-link token)
 * @returns Landing detail (incl. `invitedUserId` for the own-invite guard +
 *   `expiresAt` for the expiry check), or null if gone / no longer pending
 */
export async function findLandingById(invitationId: string): Promise<{
  studioName: string;
  studioSlug: string;
  inviterName: string;
  role: StudioRole;
  invitedUserId: string;
  expiresAt: Date;
} | null> {
  const inviterStudio = alias(studios, "inviter_studio_landing");
  const rows = await db
    .select({
      studioName: studios.name,
      studioSlug: studios.slug,
      inviterName: inviterStudio.name,
      role: studioInvitations.role,
      invitedUserId: studioInvitations.invitedUserId,
      expiresAt: studioInvitations.expiresAt,
    })
    .from(studioInvitations)
    .innerJoin(studios, eq(studios.id, studioInvitations.studioId))
    .leftJoin(
      inviterStudio,
      and(
        eq(inviterStudio.createdByUserId, studioInvitations.invitedBy),
        eq(inviterStudio.type, "personal"),
        isNull(inviterStudio.deletedAt),
      ),
    )
    .where(
      and(
        eq(studioInvitations.id, invitationId),
        eq(studioInvitations.status, "pending"),
        isNull(studioInvitations.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    studioName: row.studioName,
    studioSlug: row.studioSlug,
    inviterName: row.inviterName ?? "",
    role: row.role as StudioRole,
    invitedUserId: row.invitedUserId,
    expiresAt: row.expiresAt,
  };
}
