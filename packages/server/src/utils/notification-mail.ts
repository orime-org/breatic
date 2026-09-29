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
 * `users.locale`), from the `server.mail.*` catalog entries; the branded layout
 * and escaping live in `mail-shell.ts`.
 *
 * Auth emails (password reset / email verification) are built in
 * `modules/auth/auth-mail.ts`: those are the primary delivery channel (no bell
 * fallback) and surface their send result to the caller, so they must not go
 * through the best-effort path.
 */

import type { SendMailOptions } from "@breatic/core";
import { getDecisionWindowDays } from "@server/config/limits.js";
import { renderMail, type MailMessage } from "@server/utils/mail-shell.js";

/**
 * Build the closing line of an invitation, transfer or request email.
 *
 * The duration is read rather than written: this sentence and the deadline
 * stored on the row are the same fact told to two audiences, and a sentence
 * the recipient has no way to check is the worst place to keep a second copy
 * of a number.
 * @param what - Which kind of waiting item expires.
 * @returns The note, with the configured window in it.
 */
function expiryNote(what: "invitation" | "transfer" | "request"): MailMessage {
  return { key: `server.mail.expiry.${what}`, params: { days: getDecisionWindowDays() } };
}

/**
 * The requester's own words, as a sentence that follows the lead.
 * @param message - What they typed, or null when they gave nothing.
 * @returns The sentence, or nothing when they gave none.
 */
function reasonSentence(message: string | null): MailMessage[] {
  if (message === null || message.trim() === "") return [];
  return [{ key: "server.mail.reason", params: { message } }];
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
 * @returns `SendMailOptions` (to / subject / html / text) for `sendMail`.
 */
export function buildStudioInvitationMail(
  input: StudioInvitationMailInput,
): Promise<SendMailOptions> {
  const names = { inviter: input.inviterName, studio: input.studioName };
  return renderMail(input.locale, {
    to: input.inviteeEmail,
    subject: { key: "server.mail.studio_invite.subject", params: names },
    body: [{ key: "server.mail.studio_invite.lead", params: { ...names, role: input.role } }],
    action: { label: { key: "server.mail.studio_invite.action" }, href: input.inviteLink },
    note: expiryNote("invitation"),
  });
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
 * @returns `SendMailOptions` (to / subject / html / text) for `sendMail`.
 */
export function buildProjectInvitationMail(
  input: ProjectInvitationMailInput,
): Promise<SendMailOptions> {
  const names = { inviter: input.inviterName, project: input.projectName };
  return renderMail(input.locale, {
    to: input.inviteeEmail,
    subject: { key: "server.mail.project_invite.subject", params: names },
    body: [{ key: "server.mail.project_invite.lead", params: { ...names, role: input.role } }],
    action: { label: { key: "server.mail.project_invite.action" }, href: input.inviteLink },
    note: expiryNote("invitation"),
  });
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
 * @returns `SendMailOptions` (to / subject / html / text) for `sendMail`.
 */
export function buildStudioTransferMail(
  input: StudioTransferMailInput,
): Promise<SendMailOptions> {
  const names = { initiator: input.initiatorName, studio: input.studioName };
  return renderMail(input.locale, {
    to: input.recipientEmail,
    subject: { key: "server.mail.studio_transfer.subject", params: names },
    body: [{ key: "server.mail.studio_transfer.lead", params: names }],
    action: { label: { key: "server.mail.studio_transfer.action" }, href: input.decisionLink },
    note: expiryNote("transfer"),
  });
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
 * @returns `SendMailOptions` (to / subject / html / text) for `sendMail`.
 */
export function buildProjectTransferMail(
  input: ProjectTransferMailInput,
): Promise<SendMailOptions> {
  const names = { initiator: input.initiatorName, project: input.projectName };
  return renderMail(input.locale, {
    to: input.recipientEmail,
    subject: { key: "server.mail.project_transfer.subject", params: names },
    body: [{ key: "server.mail.project_transfer.lead", params: names }],
    action: { label: { key: "server.mail.project_transfer.action" }, href: input.decisionLink },
    note: expiryNote("transfer"),
  });
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
): Promise<SendMailOptions> {
  const names = { requester: input.requesterName, project: input.projectName };
  return renderMail(input.locale, {
    to: input.ownerEmail,
    subject: { key: "server.mail.role_upgrade.subject", params: names },
    body: [
      { key: "server.mail.role_upgrade.lead", params: { ...names, role: input.requestedRole } },
      ...reasonSentence(input.message),
    ],
    action: { label: { key: "server.mail.role_upgrade.action" }, href: input.decisionLink },
    // Not "transfer request": nothing is changing hands, somebody is asking
    // for a bigger role on something that stays where it is.
    note: expiryNote("request"),
  });
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
): Promise<SendMailOptions> {
  const names = { requester: input.requesterName, project: input.projectName };
  return renderMail(input.locale, {
    to: input.ownerEmail,
    subject: { key: "server.mail.project_join.subject", params: names },
    body: [
      { key: "server.mail.project_join.lead", params: names },
      ...reasonSentence(input.message),
    ],
    action: { label: { key: "server.mail.project_join.action" }, href: input.decisionLink },
    note: expiryNote("request"),
  });
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
 * @returns `SendMailOptions` (to / subject / html / text) for `sendMail`.
 */
export function buildMembershipEndedMail(
  input: MembershipEndedMailInput,
): Promise<SendMailOptions> {
  return renderMail(input.locale, {
    to: input.recipientEmail,
    subject: { key: "server.mail.membership_ended.subject", params: { tier: input.tierLabel } },
    body: [{ key: "server.mail.membership_ended.lead", params: { tier: input.tierLabel } }],
    note: { key: "server.mail.membership_ended.footer" },
  });
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
 * @returns `SendMailOptions` (to / subject / html / text) for `sendMail`.
 */
export function buildStorageQuotaExceededMail(
  input: StorageQuotaExceededMailInput,
): Promise<SendMailOptions> {
  return renderMail(input.locale, {
    to: input.recipientEmail,
    subject: { key: "server.mail.storage_full.subject" },
    body: [{ key: "server.mail.storage_full.lead", params: { studio: input.studioName } }],
    note: { key: "server.mail.storage_full.footer" },
  });
}
