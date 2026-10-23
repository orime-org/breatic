// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * breatic/no-drizzle-type-leak): callers see the hand-written shapes below and
 * `PendingInvitationSummary` (a `@breatic/shared` entity).
 */

import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, studioInvitations, studios, users } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { PendingInvitationSummary, StudioRole } from "@breatic/shared";
import type { RecipientInvitation, EmailInvitationCandidate } from "@server/modules/invitation/invitation.types.js";
import { mintShareToken } from "@server/utils/share-token.js";

/** Roles an invite may grant — admin is granted via transfer, never invite. */
type InvitableRole = "maintainer" | "guest";

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

/** A freshly filed request: its id, and the token that names it in a link. */
export interface CreatedRequest {
  id: string;
  shareToken: string;
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
 * @param input.role - Granted studio role (maintainer | guest)
 * @param input.invitedBy - The inviting admin's user id
 * @param input.expiresAt - When the invite times out (matches the notification TTL)
 * @param input.tx - Optional drizzle transaction handle
 * @returns The new invitation's id and its share token
 * @throws {Error} if the insert returns no row (should never happen)
 */
export async function createPending(input: {
  studioId: string;
  invitedUserId: string;
  role: InvitableRole;
  invitedBy: string;
  expiresAt: Date;
  tx?: DbTx;
}): Promise<CreatedRequest> {
  const handle = input.tx ?? db;
  const rows = await handle
    .insert(studioInvitations)
    .values({
      studioId: input.studioId,
      invitedUserId: input.invitedUserId,
      role: input.role,
      invitedBy: input.invitedBy,
      status: "pending",
      shareToken: mintShareToken(),
      expiresAt: input.expiresAt,
    })
    .returning({ id: studioInvitations.id, shareToken: studioInvitations.shareToken });
  const row = rows[0];
  if (!row) {
    throw new Error("studioInvitationsRepo.createPending: insert returned no row");
  }
  return { id: row.id, shareToken: row.shareToken };
}

/**
 * Reap the caller's stale pending invite for a (studio, invitee) pair — fail an
 * EXPIRED, still-`pending` row with reason `expired` so it stops
 * occupying the `studio_invitations_one_pending` partial unique index.
 *
 * The index keys on `status = 'pending' AND deleted_at IS NULL` and CANNOT
 * include `expires_at` (a partial-index predicate must be immutable — `now()` is
 * not). Every READ path already treats an expired pending as void (accept CAS,
 * `listPendingByStudio`, landing all gate `expires_at > clock_timestamp()`), so without this
 * the row is invisible everywhere yet still trips the unique index on re-invite
 * → a spurious "already invited" (#1769). Called inside `createInvite`'s
 * transaction right before {@link createPending}, so freeing the slot and taking
 * it are atomic. Only ever touches EXPIRED pendings — a LIVE pending is left to
 * trip the index (a real duplicate invite must still be rejected).
 * @param studioId - The studio the invite is into
 * @param invitedUserId - The invitee whose stale pending is being reaped
 * @param tx - The enclosing transaction (shared with the fresh insert)
 */
export async function expireStalePending(
  studioId: string,
  invitedUserId: string,
  tx: DbTx,
): Promise<void> {
  await tx
    .update(studioInvitations)
    .set({ status: "failed", failedReason: "expired" })
    .where(
      and(
        eq(studioInvitations.studioId, studioId),
        eq(studioInvitations.invitedUserId, invitedUserId),
        eq(studioInvitations.status, "pending"),
        isNull(studioInvitations.deletedAt),
        lte(studioInvitations.expiresAt, sql`clock_timestamp()`),
      ),
    );
}

/**
 * Link the bell notification to an invite (set right after the notification is
 * created, in the same transaction) so settling the invite can mark it read —
 * whether the invitee answered on the decision page or the inviter revoked it.
 * Nothing is answered inside the bell, so without this the row would linger.
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
 * Which studio an invitation points at, read WITHOUT a lock.
 *
 * `confirmInvite` is handed an invitation id and nothing else, but it takes the
 * studio's row lock BEFORE the accept CAS, so the id has to be reachable ahead
 * of it. That order mirrors the project side, where `archiveProject` locks
 * `projects` first and sweeps its invitations second and the opposite order
 * would close a deadlock cycle; nothing sweeps studio invitations under the
 * studio row, so on this side the order is a precaution rather than a fix. Reading it unlocked
 * is safe for two reasons — an invitation's `studio_id` never changes, and whether
 * the invite may still be accepted is decided by {@link acceptIfPending}, not
 * here. Rows that are soft-deleted or point at nothing are simply absent.
 * @param id - Invitation id
 * @param tx - Optional drizzle transaction handle
 * @returns The studio id, or null when no live invitation has that id
 */
export async function getTargetStudioId(
  id: string,
  tx?: DbTx,
): Promise<string | null> {
  const rows = await (tx ?? db)
    .select({ studioId: studioInvitations.studioId })
    .from(studioInvitations)
    .where(and(eq(studioInvitations.id, id), isNull(studioInvitations.deletedAt)))
    .limit(1);
  return rows[0]?.studioId ?? null;
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
        gt(studioInvitations.expiresAt, sql`clock_timestamp()`),
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
  if (!row || row.invitedUserId === null) return null;
  return { ...row, invitedUserId: row.invitedUserId, role: row.role as StudioRole };
}

/**
 * Decline CAS — flip a LIVE pending invite owned by `invitedUserId` to
 * `declined`; the studio membership is untouched. Returns the attached
 * notification id (to mark read) or null when nothing matched (already decided
 * / not owned / past the decision window).
 *
 * The not-expired predicate is the same one the accept CAS carries: expiry
 * closes the invite outright, so both answers stop at the same instant rather
 * than leaving "no" available after "yes" has lapsed.
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
        gt(studioInvitations.expiresAt, sql`clock_timestamp()`),
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
): Promise<{ notificationId: string | null; invitedUserId: string | null } | null> {
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
 * Mirrors `studioMembers.listByStudio`: joins the invitee to `users` for
 * `email` and to their personal studio for the display `name` + `avatar`, plus
 * the inviter's personal studio for `invitedByName` (two `studios` aliases).
 * Only `status = 'pending'` and non-expired, non-deleted rows; newest first.
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
      email: sql<string>`coalesce(${users.email}, ${studioInvitations.invitedEmail})`,
      avatarUrl: inviteeStudio.avatarUrl,
      role: studioInvitations.role,
      invitedByName: inviterStudio.name,
      expiresAt: studioInvitations.expiresAt,
    })
    .from(studioInvitations)
    .leftJoin(users, eq(users.id, studioInvitations.invitedUserId))
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
        gt(studioInvitations.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(desc(studioInvitations.createdAt));
  return rows.map((r) => ({
    invitationId: r.invitationId,
    invitedUserId: r.invitedUserId,
    awaitingSignup: r.invitedUserId === null,
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
  invitedUserId: string | null;
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


/** Fields shared by recipient arbitration and delivery settlement. */
const recipientFields = {
  id: studioInvitations.id,
  targetId: studioInvitations.studioId,
  invitedUserId: studioInvitations.invitedUserId,
  invitedEmail: studioInvitations.invitedEmail,
  invitedBy: studioInvitations.invitedBy,
  role: studioInvitations.role,
  status: studioInvitations.status,
  notificationId: studioInvitations.notificationId,
  shareToken: studioInvitations.shareToken,
  expiresAt: studioInvitations.expiresAt,
  deletedAt: studioInvitations.deletedAt,
};

/**
 * Insert an invitation addressed to a normalized mailbox.
 * @param input - Target, mailbox, role, sender, deadline and enclosing transaction.
 * @param input.studioId - The Studio id.
 * @param input.invitedEmail - Normalized recipient mailbox.
 * @param input.role - Granted membership role.
 * @param input.invitedBy - The acting inviter.
 * @param input.expiresAt - Invitation deadline.
 * @param input.tx - The enclosing transaction.
 * @returns The invitation id and stable share token.
 * @throws {Error} When persistence fails.
 */
export async function createPendingEmail(input: {
  studioId: string;
  invitedEmail: string;
  role: InvitableRole;
  invitedBy: string;
  expiresAt: Date;
  tx: DbTx;
}): Promise<CreatedRequest> {
  const [row] = await input.tx.insert(studioInvitations).values({
    studioId: input.studioId,
    invitedEmail: input.invitedEmail,
    invitedUserId: null,
    role: input.role,
    invitedBy: input.invitedBy,
    expiresAt: input.expiresAt,
    status: "pending",
    shareToken: mintShareToken(),
  }).returning({ id: studioInvitations.id, shareToken: studioInvitations.shareToken });
  if (!row) throw new Error("Email invitation insert returned no row");
  return row;
}

/**
 * Reap stale pending mailbox invitations while the target is locked.
 * @param targetId - Membership target.
 * @param email - Normalized mailbox.
 * @param tx - Enclosing transaction.
 * @returns Once the stale rows have been reaped.
 * @throws {Error} When persistence fails.
 */
export async function expireStalePendingEmail(targetId: string, email: string, tx: DbTx): Promise<void> {
  await tx.update(studioInvitations).set({ status: "failed", failedReason: "expired" }).where(and(
    eq(studioInvitations.studioId, targetId), eq(studioInvitations.invitedEmail, email),
    eq(studioInvitations.status, "pending"), isNull(studioInvitations.deletedAt), lte(studioInvitations.expiresAt, sql`clock_timestamp()`),
  ));
}

/**
 * Read both recipient representations after the membership target is locked.
 * @param targetId - Membership target.
 * @param email - Normalized mailbox.
 * @param userId - Current account associated with that mailbox.
 * @param tx - Enclosing transaction.
 * @returns Active pending invitations for this recipient.
 * @throws {Error} When persistence fails.
 */
export async function findPendingForRecipient(targetId: string, email: string, userId: string | null, tx: DbTx): Promise<RecipientInvitation[]> {
  return tx.select(recipientFields).from(studioInvitations).where(and(
    eq(studioInvitations.studioId, targetId), eq(studioInvitations.status, "pending"),
    isNull(studioInvitations.deletedAt), gt(studioInvitations.expiresAt, sql`clock_timestamp()`),
    or(eq(studioInvitations.invitedEmail, email), userId === null ? undefined : eq(studioInvitations.invitedUserId, userId)),
  ));
}

/**
 * Read the original invitation even after it has reached a terminal state.
 * @param id - Original invitation id.
 * @param tx - Enclosing transaction.
 * @returns Its current persisted facts, or null.
 * @throws {Error} When persistence fails.
 */
export async function findRecipientById(id: string, tx?: DbTx): Promise<RecipientInvitation | null> {
  const [row] = await (tx ?? db).select(recipientFields).from(studioInvitations).where(eq(studioInvitations.id, id)).limit(1);
  return row ?? null;
}

/**
 * Read the invitation named by a registration link.
 * @param token - Stable share token.
 * @returns Its persisted facts, including deletion, or null.
 * @throws {Error} When persistence fails.
 */
export async function findRecipientByToken(token: string): Promise<RecipientInvitation | null> {
  const [row] = await db.select(recipientFields).from(studioInvitations).where(eq(studioInvitations.shareToken, token)).limit(1);
  return row ?? null;
}

/**
 * Find mailbox invitations for one verified account's compensation scan.
 * @param email - Normalized account mailbox.
 * @returns Independent invitation targets to process one transaction at a time.
 * @throws {Error} When persistence fails.
 */
export async function findPendingEmailCandidates(email: string): Promise<EmailInvitationCandidate[]> {
  return db.select({ id: studioInvitations.id, targetId: studioInvitations.studioId }).from(studioInvitations).where(and(
    eq(studioInvitations.invitedEmail, email), isNull(studioInvitations.invitedUserId),
    eq(studioInvitations.status, "pending"), isNull(studioInvitations.deletedAt), gt(studioInvitations.expiresAt, sql`clock_timestamp()`),
  ));
}

/**
 * Claim a live mailbox invitation for its verified account.
 * @param id - The original invitation.
 * @param email - Normalized mailbox checked inside the target lock.
 * @param userId - Verified account with that mailbox.
 * @param decisionWindowMs - The renewed decision window in milliseconds.
 * @param tx - Enclosing claim and notification transaction.
 * @returns The converted row, or null when the compare-and-set lost.
 * @throws {Error} When persistence fails.
 */
export async function claimPendingEmail(id: string, email: string, userId: string, decisionWindowMs: number, tx: DbTx): Promise<RecipientInvitation | null> {
  const [row] = await tx.update(studioInvitations).set({
    invitedUserId: userId, invitedEmail: null, claimedAt: sql`statement_timestamp()`,
    expiresAt: sql`statement_timestamp() + ${decisionWindowMs} * interval '1 millisecond'`,
  }).where(and(
    eq(studioInvitations.id, id), eq(studioInvitations.invitedEmail, email), isNull(studioInvitations.invitedUserId),
    eq(studioInvitations.status, "pending"), isNull(studioInvitations.deletedAt), gt(studioInvitations.expiresAt, sql`clock_timestamp()`),
  )).returning(recipientFields);
  return row ?? null;
}

/**
 * Revoke the original live mailbox invitation after its delivery failed.
 * @param id - The invitation created by the failed request.
 * @param tx - Enclosing target-locked settlement transaction.
 * @returns Whether the mailbox invitation was revoked.
 * @throws {Error} When persistence fails.
 */
export async function revokePendingEmail(id: string, tx: DbTx): Promise<boolean> {
  const rows = await tx.update(studioInvitations).set({ status: "revoked" }).where(and(
    eq(studioInvitations.id, id), eq(studioInvitations.status, "pending"), isNull(studioInvitations.invitedUserId),
    isNull(studioInvitations.deletedAt), gt(studioInvitations.expiresAt, sql`clock_timestamp()`),
  )).returning({ id: studioInvitations.id });
  return rows.length === 1;
}
