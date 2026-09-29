// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Notification email templates — the best-effort half of every bell
 * notification that also goes out by mail.
 *
 * These builders are best-effort NOTIFICATION emails: the bell
 * notification is the always-delivered path, the email is an optional
 * enhancement that only fires when an SMTP backend is configured. Each renders
 * in the recipient's language, passed in as `locale` (the recipient's
 * `users.locale`), from the `server.mail.*` catalog entries; the HTML shell and
 * escaping live in `mail-shell.ts`.
 *
 * Auth emails (password reset / email verification) are built in
 * `modules/auth/auth-mail.ts`: those are the primary delivery channel (no bell
 * fallback) and surface their send result to the caller, so they must not go
 * through the best-effort path.
 */

import { runWithLocale, type SendMailOptions } from "@breatic/core";
import { getDecisionWindowDays } from "@server/config/limits.js";
import { mailHtml, mailSubject, renderMail } from "@server/utils/mail-shell.js";

/**
 * Build the closing line of an invitation, transfer or request email.
 *
 * The duration is read rather than written: this sentence and the deadline
 * stored on the row are the same fact told to two audiences, and a sentence
 * the recipient has no way to check is the worst place to keep a second copy
 * of a number.
 * @param what - Which kind of waiting item expires.
 * @returns The footer sentence, with the configured window in it.
 */
function expiryFooter(what: "invitation" | "transfer" | "request"): string {
  return mailHtml(`server.mail.expiry.${what}`, { days: getDecisionWindowDays() });
}

/**
 * The requester's own words, as a sentence appended to the lead.
 * @param message - What they typed, or null when they gave nothing.
 * @returns The sentence with a leading space, or an empty string.
 */
function reasonSentence(message: string | null): string {
  if (message === null || message.trim() === "") return "";
  return ` ${mailHtml("server.mail.reason", { message })}`;
}

/** Fields for the studio invitation email. */
export interface StudioInvitationMailInput {
  /** The invitee's language. */
  locale: string;
  inviteeEmail: string;
  inviterName: string;
  studioName: string;
  role: string;
  /** Full landing link, e.g. `https://breatic.ai/decision?token=<token>`. */
  inviteLink: string;
}

/**
 * Build the studio invitation email — the invitee opens the link and lands on
 * the decision page, where they answer (NOT auto-accept). The bell row leads
 * to that same page, so both entrances end in one place.
 * @param input - The invitee's language and email, inviter + studio names, role, and the landing link.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildStudioInvitationMail(
  input: StudioInvitationMailInput,
): SendMailOptions {
  const names = { inviter: input.inviterName, studio: input.studioName };
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.inviteeEmail,
      subject: mailSubject("server.mail.studio_invite.subject", names),
      leadHtml: mailHtml("server.mail.studio_invite.lead", { ...names, role: input.role }),
      actionHtml: mailHtml("server.mail.studio_invite.action", {}, input.inviteLink),
      footerHtml: expiryFooter("invitation"),
    }),
  );
}

/** Fields for the project invitation email. */
export interface ProjectInvitationMailInput {
  /** The invitee's language. */
  locale: string;
  inviteeEmail: string;
  inviterName: string;
  projectName: string;
  role: string;
  /** Full landing link, e.g. `https://breatic.ai/decision?token=<token>`. */
  inviteLink: string;
}

/**
 * Build the project invitation email — the invitee opens the link and lands on
 * the decision page, where they answer (NOT auto-accept). The bell row leads
 * to that same page, so both entrances end in one place.
 * @param input - The invitee's language and email, inviter + project names, role, and the landing link.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildProjectInvitationMail(
  input: ProjectInvitationMailInput,
): SendMailOptions {
  const names = { inviter: input.inviterName, project: input.projectName };
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.inviteeEmail,
      subject: mailSubject("server.mail.project_invite.subject", names),
      leadHtml: mailHtml("server.mail.project_invite.lead", { ...names, role: input.role }),
      actionHtml: mailHtml("server.mail.project_invite.action", {}, input.inviteLink),
      footerHtml: expiryFooter("invitation"),
    }),
  );
}

/** Fields for the studio transfer-admin email. */
export interface StudioTransferMailInput {
  /** The recipient's language. */
  locale: string;
  recipientEmail: string;
  initiatorName: string;
  studioName: string;
  /** Opens the shared landing page for this transfer. */
  decisionLink: string;
}

/**
 * Build the studio transfer-admin email — the recipient accepts / declines from
 * their bell notifications, and its link opens the same `/decision?token=`
 * landing page every waiting request is answered on.
 * @param input - The recipient's language and email, initiator + studio names, and the app link.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildStudioTransferMail(
  input: StudioTransferMailInput,
): SendMailOptions {
  const names = { initiator: input.initiatorName, studio: input.studioName };
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.recipientEmail,
      subject: mailSubject("server.mail.studio_transfer.subject", names),
      leadHtml: mailHtml("server.mail.studio_transfer.lead", names),
      actionHtml: mailHtml("server.mail.studio_transfer.action", {}, input.decisionLink),
      footerHtml: expiryFooter("transfer"),
    }),
  );
}

/** Fields for the project transfer-owner email. */
export interface ProjectTransferMailInput {
  /** The recipient's language. */
  locale: string;
  recipientEmail: string;
  initiatorName: string;
  projectName: string;
  /** Opens the shared landing page for this transfer. */
  decisionLink: string;
}

/**
 * Build the project transfer-owner email — the recipient accepts / declines from
 * their bell notifications, and its link opens the same `/decision?token=`
 * landing page every waiting request is answered on.
 * @param input - The recipient's language and email, initiator + project names, and the app link.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildProjectTransferMail(
  input: ProjectTransferMailInput,
): SendMailOptions {
  const names = { initiator: input.initiatorName, project: input.projectName };
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.recipientEmail,
      subject: mailSubject("server.mail.project_transfer.subject", names),
      leadHtml: mailHtml("server.mail.project_transfer.lead", names),
      actionHtml: mailHtml("server.mail.project_transfer.action", {}, input.decisionLink),
      footerHtml: expiryFooter("transfer"),
    }),
  );
}

/** Fields for the role-upgrade request email, sent to the project's owner. */
export interface RoleUpgradeRequestMailInput {
  /** The owner's language. */
  locale: string;
  ownerEmail: string;
  requesterName: string;
  projectName: string;
  requestedRole: string;
  /** The requester's own words; null when they gave none. */
  message: string | null;
  decisionLink: string;
}

/**
 * Builds the email telling a project's owner that somebody wants a bigger role.
 *
 * The reason the requester typed is included because it is the whole basis
 * for the answer.
 * @param input - The owner's language and email, names, requested role, reason and link.
 * @returns The mail options to send.
 */
export function buildRoleUpgradeRequestMail(
  input: RoleUpgradeRequestMailInput,
): SendMailOptions {
  const names = { requester: input.requesterName, project: input.projectName };
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.ownerEmail,
      subject: mailSubject("server.mail.role_upgrade.subject", names),
      leadHtml:
        mailHtml("server.mail.role_upgrade.lead", { ...names, role: input.requestedRole }) +
        reasonSentence(input.message),
      actionHtml: mailHtml("server.mail.role_upgrade.action", {}, input.decisionLink),
      // Not "transfer request": nothing is changing hands, somebody is asking
      // for a bigger role on something that stays where it is.
      footerHtml: expiryFooter("request"),
    }),
  );
}

/** Fields for the join-request email, sent to the project's owner. */
export interface ProjectJoinRequestMailInput {
  /** The owner's language. */
  locale: string;
  ownerEmail: string;
  requesterName: string;
  projectName: string;
  /** The requester's own words; null when they gave none. */
  message: string | null;
  decisionLink: string;
}

/**
 * Builds the email telling a project's owner that a studio member asked to join.
 * @param input - The owner's language and email, names, reason and link.
 * @returns The mail options to send.
 */
export function buildProjectJoinRequestMail(
  input: ProjectJoinRequestMailInput,
): SendMailOptions {
  const names = { requester: input.requesterName, project: input.projectName };
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.ownerEmail,
      subject: mailSubject("server.mail.project_join.subject", names),
      leadHtml: mailHtml("server.mail.project_join.lead", names) + reasonSentence(input.message),
      actionHtml: mailHtml("server.mail.project_join.action", {}, input.decisionLink),
      footerHtml: expiryFooter("request"),
    }),
  );
}

/** Fields for the membership-ended email. */
export interface MembershipEndedMailInput {
  /** The recipient's language. */
  locale: string;
  /** Where to send it. */
  recipientEmail: string;
  /** The paid tier that just ended, as the product names it. */
  tierLabel: string;
}

/**
 * Build the membership-ended email (#106 §9).
 *
 * A notice, not a request: nothing is waiting to be answered, so it carries no
 * action link and no deadline. The bell row beside it is the delivery
 * guarantee; this only leaves when an SMTP backend is configured.
 * @param input - The recipient's language and email, and the tier that ended.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildMembershipEndedMail(
  input: MembershipEndedMailInput,
): SendMailOptions {
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.recipientEmail,
      subject: mailSubject("server.mail.membership_ended.subject", { tier: input.tierLabel }),
      leadHtml: mailHtml("server.mail.membership_ended.lead", { tier: input.tierLabel }),
      footerHtml: mailHtml("server.mail.membership_ended.footer"),
    }),
  );
}

/** What the storage-full email needs. */
interface StorageQuotaExceededMailInput {
  /** The recipient's language. */
  locale: string;
  /** Where to send it — the admin of the studio the write was aimed at. */
  recipientEmail: string;
  /** The studio that write was aimed at, for "where did this happen". */
  studioName: string;
}

/**
 * Build the storage-full email (#89).
 *
 * A notice, not a request: nothing is waiting to be answered, so no action
 * link and no deadline.
 *
 * Says the ACCOUNT is full, not the studio, and the difference is about WHEN
 * it is read. The sentence on the operator's screen names the studio because
 * they are looking at it right then; this arrives by mail and may be opened
 * hours later, by somebody who administers several studios — naming one of
 * them would send them to look at whichever studio happened to trigger it,
 * which may hold hardly anything.
 * @param input - The recipient's language and email, and the studio the refused write was aimed at.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildStorageQuotaExceededMail(
  input: StorageQuotaExceededMailInput,
): SendMailOptions {
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.recipientEmail,
      subject: mailSubject("server.mail.storage_full.subject"),
      leadHtml: mailHtml("server.mail.storage_full.lead", { studio: input.studioName }),
      footerHtml: mailHtml("server.mail.storage_full.footer"),
    }),
  );
}
