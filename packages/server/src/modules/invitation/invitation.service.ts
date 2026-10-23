// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ConflictError, logger, NotFoundError } from "@breatic/core";
import { enqueueMail } from "@breatic/domain";
import { getActiveLocale, normalizeEmail, t } from "@breatic/shared";
import type { SignupInvitationPreview } from "@breatic/shared";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
export { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
import { invitationRepo, prepareInvitation, settleSignupInvitationDelivery } from "@server/modules/invitation/invitation-lifecycle.service.js";
import type { InvitationKind, InvitationRole } from "@server/modules/invitation/invitation.types.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import { frontendOrigin } from "@server/utils/frontend-origin.js";
import { decisionLink } from "@server/utils/decision-link.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import {
  buildProjectInvitationMail, buildStudioInvitationMail,
  buildProjectSignupInvitationMail, buildStudioSignupInvitationMail,
} from "@server/utils/notification-mail.js";

/** The committed result used by the two membership route adapters. */
export interface CreatedInvitation {
  invitationId: string;
  inviteeUserId: string | null;
  inviteeEmail: string;
  inviterName: string;
  targetName: string;
  studioId: string;
  pendingSignup: boolean;
}

/**
 * Create an account or mailbox invitation and settle its delivery result.
 * @param kind - Membership target kind.
 * @param targetId - The target id.
 * @param invitedBy - The acting administrator or owner.
 * @param email - The recipient mailbox.
 * @param role - The granted membership role.
 * @param origin - Trusted frontend origin supplied by the route.
 * @returns The invitation and the delivery path observed under the target lock.
 * @throws {ConflictError} When duplicate, already a member, full or undelivered.
 * @throws {NotFoundError} When the target or invitation is closed.
 * @throws {Error} When persistence fails.
 */
export async function createInvitation(
  kind: InvitationKind, targetId: string, invitedBy: string, email: string, role: InvitationRole, origin?: string,
): Promise<CreatedInvitation> {
  let prepared;
  try {
    prepared = await prepareInvitation({ kind, targetId, invitedBy, email, role });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(t(`server.${kind}.already_invited`));
    throw err;
  }
  if (prepared.duplicate) throw new ConflictError(t(`server.${kind}.already_invited`));
  const { invitation, target, invitee, inviterName } = prepared;
  const normalizedEmail = normalizeEmail(email);
  let pendingSignup = invitee === null;
  if (invitee) {
    if (origin) {
      await sendBestEffortMail(async () => {
        const common = { locale: invitee.locale, inviteeEmail: normalizedEmail, inviterName, role, inviteLink: decisionLink(origin, invitation.shareToken) };
        return kind === "project"
          ? buildProjectInvitationMail({ ...common, projectName: target.name })
          : buildStudioInvitationMail({ ...common, studioName: target.name });
      }, { userId: invitee.id, subject: `${kind}_invite` });
    }
  } else {
    const registered = await usersRepo.getUserByEmail(normalizedEmail);
    if (registered?.emailVerified) await claimEmailInvitations(registered);
    let delivered = false;
    try {
      const common = {
        locale: getActiveLocale(), inviteeEmail: normalizedEmail, inviterName, role,
        inviteLink: `${origin ?? frontendOrigin()}/register?invite=${invitation.shareToken}`,
      };
      const mail = await (kind === "project"
        ? buildProjectSignupInvitationMail({ ...common, projectName: target.name })
        : buildStudioSignupInvitationMail({ ...common, studioName: target.name }));
      await enqueueMail({ mail, ctx: { subject: `${kind}_signup_invite` } });
      delivered = true;
    } catch (err) {
      logger.error({ err, ctx: { kind, invitationId: invitation.id, inviterUserId: invitedBy } }, "signup_invitation_mail_enqueue_failed");
    }
    pendingSignup = await settleSignupInvitationDelivery(kind, invitation.id, targetId, delivered);
  }
  const settled = await invitationRepo(kind).findRecipientById(invitation.id);
  return {
    invitationId: invitation.id, inviteeUserId: settled?.invitedUserId ?? invitee?.id ?? null,
    inviteeEmail: normalizedEmail, inviterName, targetName: target.name, studioId: target.studioId, pendingSignup,
  };
}

/**
 * Read the public preview named by a registration email's random token.
 * @param token - The stable invitation share token.
 * @returns Public mailbox information or the claimed/closed state.
 * @throws {NotFoundError} When no invitation has this token.
 * @throws {Error} When persistence fails.
 */
export async function getInvitationPreview(token: string): Promise<SignupInvitationPreview> {
  for (const kind of ["project", "studio"] as const) {
    const invitation = await invitationRepo(kind).findRecipientByToken(token);
    if (!invitation) continue;
    if (invitation.invitedUserId !== null) return { state: "claimed" };
    const target = kind === "project"
      ? await projectRepo.getProjectById(invitation.targetId)
      : await studioRepo.getById(invitation.targetId);
    const archived = target !== null && "archivedAt" in target && target.archivedAt !== null;
    if (!target || archived || invitation.deletedAt !== null || invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now()) {
      return { state: "closed" };
    }
    const profiles = await studioRepo.getPersonalProfilesByCreators([invitation.invitedBy]);
    if (invitation.invitedEmail === null) throw new Error("Mailbox invitation requires an address");
    return {
      state: "open", email: invitation.invitedEmail, inviterName: profiles.get(invitation.invitedBy)?.name ?? "",
      kind, targetName: target.name, role: invitation.role,
    };
  }
  throw new NotFoundError(t("server.error.not_found"));
}
