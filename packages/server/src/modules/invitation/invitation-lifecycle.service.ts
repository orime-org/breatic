// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ConflictError, db, ForbiddenError, getLimitsForStudio, NotFoundError, projectMembersRepo } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { normalizeEmail, t } from "@breatic/shared";
import type { InvitableProjectRole, UserEntity } from "@breatic/shared";
import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import * as projectInvites from "@server/modules/project-invite/projectInvitations.repo.js";
import * as studioInvites from "@server/modules/studio/studioInvitations.repo.js";
import * as notifications from "@server/modules/notification/notification.service.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import { emailVerificationEnabled } from "@server/modules/auth/signup-code.service.js";
import { getDecisionWindowMs } from "@server/config/limits.js";
import type { InvitationKind, InvitationRole, RecipientInvitation } from "@server/modules/invitation/invitation.types.js";

/** The live membership target held by the current transaction. */
export interface InvitationTarget {
  kind: InvitationKind;
  id: string;
  studioId: string;
  name: string;
}

/** Committed recipient arbitration, before the delivery attempt. */
export interface PreparedInvitation {
  duplicate: boolean;
  invitation: RecipientInvitation;
  target: InvitationTarget;
  invitee: UserEntity | null;
  inviterName: string;
}

/**
 * Select the repository owning this kind of invitation.
 * @param kind - The membership target kind.
 * @returns Its repository.
 */
export function invitationRepo(kind: InvitationKind): typeof projectInvites | typeof studioInvites {
  return kind === "project" ? projectInvites : studioInvites;
}

/**
 * Lock a membership target before reading or changing invitation rows.
 * @param kind - The membership target kind.
 * @param id - The target id.
 * @param tx - The enclosing transaction.
 * @returns The locked live target, or null when closed.
 * @throws {ForbiddenError} When a personal Studio is invited into.
 * @throws {Error} When persistence fails.
 */
async function lockTarget(kind: InvitationKind, id: string, tx: DbTx): Promise<InvitationTarget | null> {
  if (kind === "project") {
    if (!await projectRepo.lockLiveProject(id, tx)) return null;
    const project = await projectRepo.getProjectById(id, tx);
    return project ? { kind, id, studioId: project.studioId, name: project.name } : null;
  }
  if (!await studioRepo.lockStudio(id, tx)) return null;
  const studio = await studioRepo.getById(id, tx);
  if (!studio) return null;
  if (studio.type === "personal") throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  return { kind, id, studioId: id, name: studio.name };
}

/**
 * Read the inviter's current display name in the invitation transaction.
 * @param userId - The inviter.
 * @param tx - The enclosing transaction.
 * @returns Their display name.
 * @throws {Error} When persistence fails.
 */
async function inviterNameOf(userId: string, tx: DbTx): Promise<string> {
  const profiles = await studioRepo.getPersonalProfilesByCreators([userId], tx);
  return profiles.get(userId)?.name ?? "";
}

/**
 * Create and attach the recipient notification in the invitation transaction.
 * @param target - The locked membership target.
 * @param invite - The invitation addressed to a registered user.
 * @param inviterName - The sender's display name.
 * @param tx - The enclosing transaction.
 * @returns Once notification and association have been written.
 * @throws {Error} When persistence fails.
 */
async function notifyRecipient(target: InvitationTarget, invite: RecipientInvitation, inviterName: string, tx: DbTx): Promise<void> {
  if (invite.invitedUserId === null) throw new Error("Recipient notification requires an account");
  const common = {
    invitationId: invite.id,
    inviterUserId: invite.invitedBy,
    inviterName,
    shareToken: invite.shareToken,
  };
  const notification = target.kind === "project"
    ? await notifications.createProjectInviteRequest({
      userId: invite.invitedUserId, projectId: target.id, expiresAt: invite.expiresAt, tx,
      payload: { ...common, projectId: target.id, projectName: target.name, role: invite.role as InvitableProjectRole },
    })
    : await notifications.createStudioInviteRequest({
      userId: invite.invitedUserId, expiresAt: invite.expiresAt, tx,
      payload: { ...common, studioId: target.id, studioName: target.name, role: invite.role as "maintainer" | "guest" },
    });
  await invitationRepo(target.kind).attachNotification(invite.id, notification.id, tx);
}

/**
 * Convert a matching mailbox row and attach its notification atomically.
 * @param target - The locked membership target.
 * @param invite - The original mailbox invitation.
 * @param user - The current verified account.
 * @param tx - The enclosing transaction.
 * @returns Whether this transaction converted the original row.
 * @throws {Error} When persistence fails.
 */
async function claimLocked(target: InvitationTarget, invite: RecipientInvitation, user: UserEntity, tx: DbTx): Promise<boolean> {
  if (!user.emailVerified || invite.invitedEmail !== normalizeEmail(user.email)) return false;
  const claimed = await invitationRepo(target.kind).claimPendingEmail(
    invite.id, normalizeEmail(user.email), user.id, new Date(Date.now() + getDecisionWindowMs()), tx,
  );
  if (!claimed) return false;
  await notifyRecipient(target, claimed, await inviterNameOf(invite.invitedBy, tx), tx);
  return true;
}

/**
 * Check an invite-time member and capacity precondition under the target lock.
 * @param target - The locked membership target.
 * @param user - Registered recipient, when present.
 * @param tx - The enclosing transaction.
 * @returns Once both preconditions hold.
 * @throws {ConflictError} When already a member or capacity is exhausted.
 * @throws {Error} When persistence fails.
 */
async function checkNewInvitation(target: InvitationTarget, user: UserEntity | null, tx: DbTx): Promise<void> {
  const role = user === null ? null : target.kind === "project"
    ? await projectMembersRepo.getRole(target.id, user.id, tx)
    : await studioMembersRepo.getRole(target.id, user.id, tx);
  if (role) throw new ConflictError(t(`server.${target.kind}.already_member`));
  const limits = await getLimitsForStudio(target.studioId, tx);
  const limit = target.kind === "project" ? limits.project_members : limits.studio_members;
  const count = target.kind === "project"
    ? await projectMembersRepo.countCollaborators(target.id, tx)
    : (await studioRepo.countMembersByStudioIds([target.id], tx)).get(target.id) ?? 0;
  if (count >= limit) throw new ConflictError(t(
    target.kind === "project" ? "server.project.collaborator_limit_reached" : "server.studio.member_limit_reached", { limit },
  ));
}

/**
 * Arbitrate both recipient representations and file or reuse one invitation.
 * @param input - Membership target, recipient, role and sender.
 * @param input.kind - Membership target kind.
 * @param input.targetId - The target id.
 * @param input.email - Recipient mailbox.
 * @param input.role - Granted membership role.
 * @param input.invitedBy - The acting inviter.
 * @returns The committed invitation, with duplicate results kept outside rollback.
 * @throws {NotFoundError} When the target or required mail channel is unavailable.
 * @throws {ConflictError} When member or capacity preconditions fail.
 * @throws {Error} When persistence fails.
 */
export async function prepareInvitation(input: {
  kind: InvitationKind;
  targetId: string;
  email: string;
  role: InvitationRole;
  invitedBy: string;
}): Promise<PreparedInvitation> {
  const email = normalizeEmail(input.email);
  return db.transaction(async (tx) => {
    const target = await lockTarget(input.kind, input.targetId, tx);
    if (!target) throw new NotFoundError(t("server.error.not_found"));
    const repo = invitationRepo(input.kind);
    const user = await usersRepo.getUserByEmail(email, tx);
    await repo.expireStalePendingEmail(target.id, email, tx);
    if (user) await repo.expireStalePending(target.id, user.id, tx);
    const pending = await repo.findPendingForRecipient(target.id, email, user?.id ?? null, tx);
    const ordinary = pending.find((row) => row.invitedUserId !== null);
    const existing = ordinary ?? pending[0];
    const inviterName = await inviterNameOf(input.invitedBy, tx);
    if (existing) {
      if (existing.invitedUserId === null && user?.emailVerified) await claimLocked(target, existing, user, tx);
      return { duplicate: true, invitation: existing, target, invitee: user, inviterName };
    }
    await checkNewInvitation(target, user, tx);
    if (!user && !emailVerificationEnabled()) throw new NotFoundError(t(`server.${input.kind}.email_not_registered_no_mail`));
    const expiresAt = new Date(Date.now() + getDecisionWindowMs());
    const common = { invitedBy: input.invitedBy, expiresAt, tx };
    const created = input.kind === "project"
      ? user
        ? await projectInvites.createPending({ ...common, projectId: target.id, invitedUserId: user.id, role: input.role as InvitableProjectRole })
        : await projectInvites.createPendingEmail({ ...common, projectId: target.id, invitedEmail: email, role: input.role as InvitableProjectRole })
      : user
        ? await studioInvites.createPending({ ...common, studioId: target.id, invitedUserId: user.id, role: input.role as "maintainer" | "guest" })
        : await studioInvites.createPendingEmail({ ...common, studioId: target.id, invitedEmail: email, role: input.role as "maintainer" | "guest" });
    const invitation = await repo.findRecipientById(created.id, tx);
    if (!invitation) throw new Error("Created invitation could not be read");
    if (user) await notifyRecipient(target, invitation, inviterName, tx);
    return { duplicate: false, invitation, target, invitee: user, inviterName };
  });
}

/**
 * Claim one candidate after rechecking account identity under its target lock.
 * @param kind - Target kind.
 * @param id - Candidate invitation id.
 * @param targetId - Immutable target id.
 * @param userId - Account requesting conversion.
 * @returns Once the candidate has been decided.
 * @throws {Error} When persistence fails.
 */
export async function claimInvitation(kind: InvitationKind, id: string, targetId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const target = await lockTarget(kind, targetId, tx);
    if (!target) return;
    const user = await usersRepo.getUserById(userId, tx);
    if (!user?.emailVerified) return;
    const repo = invitationRepo(kind);
    const invite = await repo.findRecipientById(id, tx);
    if (!invite || invite.targetId !== targetId || invite.invitedEmail !== normalizeEmail(user.email)) return;
    await repo.expireStalePending(targetId, user.id, tx);
    const pending = await repo.findPendingForRecipient(targetId, normalizeEmail(user.email), user.id, tx);
    if (pending.some((row) => row.invitedUserId === user.id)) return;
    await claimLocked(target, invite, user, tx);
  });
}

/**
 * Settle a signup mail attempt against its original locked invitation facts.
 * @param kind - Membership target kind.
 * @param id - Original invitation id.
 * @param targetId - Its immutable target id.
 * @param delivered - Whether mail enqueue resolved.
 * @returns Whether the recipient still needs signup.
 * @throws {NotFoundError} When the original invitation is closed.
 * @throws {ConflictError} When the live mailbox invitation could not be delivered.
 * @throws {Error} When persistence fails.
 */
export async function settleSignupInvitationDelivery(kind: InvitationKind, id: string, targetId: string, delivered: boolean): Promise<boolean> {
  const outcome = await db.transaction(async (tx) => {
    const target = await lockTarget(kind, targetId, tx);
    if (!target) return "closed";
    const repo = invitationRepo(kind);
    const invite = await repo.findRecipientById(id, tx);
    if (!invite || invite.targetId !== targetId || invite.deletedAt !== null) return "closed";
    if (["accepted", "declined"].includes(invite.status) && invite.invitedUserId !== null && invite.notificationId !== null) {
      return await notificationRepo.findById(invite.notificationId, tx) ? "ordinary" : "closed";
    }
    if (invite.status !== "pending" || invite.expiresAt.getTime() <= Date.now()) return "closed";
    if (invite.invitedUserId !== null) {
      return invite.notificationId !== null && await notificationRepo.findById(invite.notificationId, tx) ? "ordinary" : "closed";
    }
    if (delivered) return "signup";
    return await repo.revokePendingEmail(id, tx) ? "mail_failed" : "closed";
  });
  if (outcome === "closed") throw new NotFoundError(t("server.error.not_found"));
  if (outcome === "mail_failed") throw new ConflictError(t(`server.${kind}.invite_mail_failed`));
  return outcome === "signup";
}
