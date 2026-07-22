// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project invitations repository — `project_invitations` table CRUD + the
 * accept / decline / revoke CAS operations (invite-confirm handshake,
 * 2026-06-18, #1337). The direct mirror of `studioInvitations.repo` for the
 * project membership layer.
 *
 * Pending project-member invites live HERE, not as a status column on
 * `project_members`, so `project_members` stays "active members only" — project
 * auth (`loadProjectRole`) / member-count queries need zero filtering and a
 * pending invitee can never be mistaken for a real member. Lives in `@server`:
 * only the server touches invites (worker / collab never do).
 *
 * Concurrency: `acceptIfPending` is a CAS (`UPDATE … WHERE status = 'pending'`)
 * — under concurrent confirms (bell + email link, or a double click) exactly
 * one UPDATE matches and returns a row; the rest return `null`. The same shape
 * backs decline / revoke. Soft delete is the only deletion mode; non-pending
 * and soft-deleted rows are treated as gone, so a previously declined /
 * expired / revoked invitee can be re-invited (a fresh pending row).
 *
 * Drizzle row types never leak past this repo (prohibition #3 /
 * lint:no-drizzle-type-leak): callers see the hand-written shapes below and the
 * `@breatic/shared` entities.
 */

import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, projectInvitations, projects, studios, users } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type {
  InvitableProjectRole,
  PendingProjectInvitationSummary,
} from "@breatic/shared";

/**
 * The membership-relevant fields of a just-accepted invite, returned by
 * {@link acceptIfPending} so the caller can write the `project_members` row and
 * mark the bell notification read — all in the same transaction.
 */
export interface AcceptedProjectInvite {
  projectId: string;
  invitedUserId: string;
  role: InvitableProjectRole;
  invitedBy: string;
  /** The bell notification to mark read (null when none was attached). */
  notificationId: string | null;
}

/**
 * Insert a fresh pending invitation; returns the new row id (the caller puts it
 * in the bell-notification payload, then links it back via
 * {@link attachNotification}).
 *
 * The `project_invitations_one_pending` partial unique index rejects a second
 * LIVE pending for the same (project, invitee) with SQLSTATE 23505 — the service
 * maps that to a ConflictError ("already invited"), no silent overwrite.
 * @param input - Project, invitee, granted role, inviting owner, TTL, optional tx
 * @param input.projectId - The project the invite is into
 * @param input.invitedUserId - The registered user being invited
 * @param input.role - Granted project role (editor | viewer)
 * @param input.invitedBy - The inviting owner's user id
 * @param input.expiresAt - When the invite times out (matches the notification TTL)
 * @param input.tx - Optional drizzle transaction handle
 * @returns The new invitation's id
 * @throws {Error} if the insert returns no row (should never happen)
 */
export async function createPending(input: {
  projectId: string;
  invitedUserId: string;
  role: InvitableProjectRole;
  invitedBy: string;
  expiresAt: Date;
  tx?: DbTx;
}): Promise<string> {
  const handle = input.tx ?? db;
  const rows = await handle
    .insert(projectInvitations)
    .values({
      projectId: input.projectId,
      invitedUserId: input.invitedUserId,
      role: input.role,
      invitedBy: input.invitedBy,
      status: "pending",
      expiresAt: input.expiresAt,
    })
    .returning({ id: projectInvitations.id });
  const row = rows[0];
  if (!row) {
    throw new Error(
      "projectInvitationsRepo.createPending: insert returned no row",
    );
  }
  return row.id;
}

/**
 * Reap the caller's stale pending invite for a (project, invitee) pair — flip an
 * EXPIRED, still-`pending` row to the terminal `expired` status so it stops
 * occupying the `project_invitations_one_pending` partial unique index.
 *
 * The index keys on `status = 'pending' AND deleted_at IS NULL` and CANNOT
 * include `expires_at` (a partial-index predicate must be immutable — `now()` is
 * not). Every READ path already treats an expired pending as void (accept CAS,
 * `listPendingByProject`, landing all gate `expires_at > now()`), so without this
 * the row is invisible everywhere yet still trips the unique index on re-invite
 * → a spurious "already invited" (#1769). Called inside `createInvite`'s
 * transaction right before {@link createPending}, so freeing the slot and taking
 * it are atomic. Only ever touches EXPIRED pendings — a LIVE pending is left to
 * trip the index (a real duplicate invite must still be rejected).
 * @param projectId - The project the invite is into
 * @param invitedUserId - The invitee whose stale pending is being reaped
 * @param tx - The enclosing transaction (shared with the fresh insert)
 */
export async function expireStalePending(
  projectId: string,
  invitedUserId: string,
  tx: DbTx,
): Promise<void> {
  await tx
    .update(projectInvitations)
    .set({ status: "expired" })
    .where(
      and(
        eq(projectInvitations.projectId, projectId),
        eq(projectInvitations.invitedUserId, invitedUserId),
        eq(projectInvitations.status, "pending"),
        isNull(projectInvitations.deletedAt),
        lte(projectInvitations.expiresAt, sql`now()`),
      ),
    );
}

/**
 * Link the bell notification to an invite (set right after the notification is
 * created, in the same transaction) so accept / decline / revoke can mark it
 * read and the bell entry disappears even when acted on via the email link.
 * @param id - Invitation id
 * @param notificationId - The `project.invite_request` notification id
 * @param tx - Optional drizzle transaction handle
 */
export async function attachNotification(
  id: string,
  notificationId: string,
  tx?: DbTx,
): Promise<void> {
  const handle = tx ?? db;
  await handle
    .update(projectInvitations)
    .set({ notificationId })
    .where(eq(projectInvitations.id, id));
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
): Promise<AcceptedProjectInvite | null> {
  const handle = tx ?? db;
  const rows = await handle
    .update(projectInvitations)
    .set({ status: "accepted" })
    .where(
      and(
        eq(projectInvitations.id, id),
        eq(projectInvitations.invitedUserId, invitedUserId),
        eq(projectInvitations.status, "pending"),
        isNull(projectInvitations.deletedAt),
        gt(projectInvitations.expiresAt, sql`now()`),
      ),
    )
    .returning({
      projectId: projectInvitations.projectId,
      invitedUserId: projectInvitations.invitedUserId,
      role: projectInvitations.role,
      invitedBy: projectInvitations.invitedBy,
      notificationId: projectInvitations.notificationId,
    });
  const row = rows[0];
  if (!row) return null;
  return { ...row, role: row.role as InvitableProjectRole };
}

/**
 * Decline CAS — flip a LIVE pending invite owned by `invitedUserId` to
 * `declined`; the project membership is untouched. Returns the attached
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
    .update(projectInvitations)
    .set({ status: "declined" })
    .where(
      and(
        eq(projectInvitations.id, id),
        eq(projectInvitations.invitedUserId, invitedUserId),
        eq(projectInvitations.status, "pending"),
        isNull(projectInvitations.deletedAt),
      ),
    )
    .returning({ notificationId: projectInvitations.notificationId });
  const row = rows[0];
  return row ? { notificationId: row.notificationId } : null;
}

/**
 * Revoke CAS — the owner cancels a LIVE pending invite in THEIR project (the
 * `project_id` guard ensures an owner can only revoke invites belonging to the
 * project they own). Returns the attached notification id + the invitee id (so
 * the caller can mark the invitee's bell notification read), or null.
 * @param id - Invitation id
 * @param projectId - The owner's project (guard: the invite must belong to it)
 * @param tx - Optional drizzle transaction handle
 * @returns `{ notificationId, invitedUserId }` of the revoked invite, or null
 *   if none matched
 */
export async function revokeIfPending(
  id: string,
  projectId: string,
  tx?: DbTx,
): Promise<{ notificationId: string | null; invitedUserId: string } | null> {
  const handle = tx ?? db;
  const rows = await handle
    .update(projectInvitations)
    .set({ status: "revoked" })
    .where(
      and(
        eq(projectInvitations.id, id),
        eq(projectInvitations.projectId, projectId),
        eq(projectInvitations.status, "pending"),
        isNull(projectInvitations.deletedAt),
      ),
    )
    .returning({
      notificationId: projectInvitations.notificationId,
      invitedUserId: projectInvitations.invitedUserId,
    });
  const row = rows[0];
  return row
    ? { notificationId: row.notificationId, invitedUserId: row.invitedUserId }
    : null;
}

/**
 * List a project's LIVE pending invitations with display fields, for the
 * owner's "invited (pending)" section.
 *
 * Joins the invitee to `users` for `email` and to their personal studio for the
 * display `name` + `avatar`, plus the inviter's personal studio for
 * `invitedByName` (two `studios` aliases). Only `status = 'pending'` and
 * non-expired, non-deleted rows; newest first.
 * @param projectId - Project UUID
 * @returns Pending invitations with display fields (empty when none)
 */
export async function listPendingByProject(
  projectId: string,
): Promise<PendingProjectInvitationSummary[]> {
  const inviteeStudio = alias(studios, "invitee_studio");
  const inviterStudio = alias(studios, "inviter_studio");
  const rows = await db
    .select({
      invitationId: projectInvitations.id,
      invitedUserId: projectInvitations.invitedUserId,
      name: inviteeStudio.name,
      email: users.email,
      avatarUrl: inviteeStudio.avatarUrl,
      role: projectInvitations.role,
      invitedByName: inviterStudio.name,
      expiresAt: projectInvitations.expiresAt,
    })
    .from(projectInvitations)
    .innerJoin(users, eq(users.id, projectInvitations.invitedUserId))
    .leftJoin(
      inviteeStudio,
      and(
        eq(inviteeStudio.createdByUserId, projectInvitations.invitedUserId),
        eq(inviteeStudio.type, "personal"),
        isNull(inviteeStudio.deletedAt),
      ),
    )
    .leftJoin(
      inviterStudio,
      and(
        eq(inviterStudio.createdByUserId, projectInvitations.invitedBy),
        eq(inviterStudio.type, "personal"),
        isNull(inviterStudio.deletedAt),
      ),
    )
    .where(
      and(
        eq(projectInvitations.projectId, projectId),
        eq(projectInvitations.status, "pending"),
        isNull(projectInvitations.deletedAt),
        gt(projectInvitations.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(projectInvitations.createdAt));
  return rows.map((r) => ({
    invitationId: r.invitationId,
    invitedUserId: r.invitedUserId,
    name: r.name ?? r.email,
    email: r.email,
    avatarUrl: r.avatarUrl,
    role: r.role as InvitableProjectRole,
    invitedByName: r.invitedByName ?? "",
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/**
 * Resolve a pending invite's landing-page detail by id (the email-link page
 * shows it before the invitee confirms). Joins the project (name + slug + id)
 * and the inviter's personal studio (name). Includes EXPIRED pendings (the page
 * renders an "expired" state) — only non-pending / soft-deleted rows return
 * null.
 * @param invitationId - Invitation id (resolved from the email-link token)
 * @returns Landing detail (incl. `invitedUserId` for the own-invite guard +
 *   `expiresAt` for the expiry check), or null if gone / no longer pending
 */
export async function findLandingById(invitationId: string): Promise<{
  projectName: string;
  projectSlug: string;
  projectId: string;
  inviterName: string;
  role: InvitableProjectRole;
  invitedUserId: string;
  expiresAt: Date;
} | null> {
  const inviterStudio = alias(studios, "inviter_studio_landing");
  const rows = await db
    .select({
      projectName: projects.name,
      projectSlug: projects.slug,
      projectId: projects.id,
      inviterName: inviterStudio.name,
      role: projectInvitations.role,
      invitedUserId: projectInvitations.invitedUserId,
      expiresAt: projectInvitations.expiresAt,
    })
    .from(projectInvitations)
    .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
    .leftJoin(
      inviterStudio,
      and(
        eq(inviterStudio.createdByUserId, projectInvitations.invitedBy),
        eq(inviterStudio.type, "personal"),
        isNull(inviterStudio.deletedAt),
      ),
    )
    .where(
      and(
        eq(projectInvitations.id, invitationId),
        eq(projectInvitations.status, "pending"),
        isNull(projectInvitations.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    projectName: row.projectName,
    projectSlug: row.projectSlug,
    projectId: row.projectId,
    inviterName: row.inviterName ?? "",
    role: row.role as InvitableProjectRole,
    invitedUserId: row.invitedUserId,
    expiresAt: row.expiresAt,
  };
}
