// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Notification email templates — the best-effort half of every bell
 * notification that also goes out by mail.
 *
 * These builders are best-effort NOTIFICATION emails: the bell
 * notification is the always-delivered path, the email is an optional
 * enhancement that only fires when an SMTP backend is configured. They share a
 * single HTML shell + a single HTML escaper here (previously copied across four
 * per-module files). English-only by design — the backend stores no per-user
 * locale, so it cannot pick the recipient's language at send time.
 *
 * Auth emails (password reset / email verification) are deliberately NOT here:
 * those are the primary delivery channel (no bell fallback) and surface their
 * send result to the caller, so they must not go through the best-effort path.
 */

import type { SendMailOptions } from "@breatic/core";
import { getDecisionWindowDays } from "@server/config/limits.js";

const BRAND = "Breatic";
/**
 * Build the closing line of an invitation, transfer or request email.
 *
 * The duration is read rather than written: this sentence and the deadline
 * stored on the row are the same fact told to two audiences, and a sentence
 * the recipient has no way to check is the worst place to keep a second copy
 * of a number.
 * @param subject - What expires, as it opens the sentence ("This invitation").
 * @returns The footer sentence, with the configured window in it.
 */
function expiryFooter(subject: string): string {
  const days = getDecisionWindowDays();
  const unit = days === 1 ? "day" : "days";
  return `${subject} expires in ${days} ${unit}. If you didn't expect it, you can ignore this email.`;
}

/**
 * Escape HTML-significant chars in user-supplied strings (XSS-safe email body).
 * @param s - The raw user-supplied string to escape.
 * @returns The string with `& < > " '` replaced by their HTML entities.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The pieces every notification email shares — assembled by {@link renderNotificationMail}. */
interface NotificationMailShell {
  /** Recipient address. */
  to: string;
  /** Plain-text subject line (email header — not HTML, not escaped). */
  subject: string;
  /** Inner HTML of the lead paragraph — the caller escapes user fields. */
  leadHtml: string;
  /**
   * Raw link target — escaped into the `href` attribute here.
   *
   * Absent on an email with nothing to do: a membership that ended is a
   * notice, and a link that only says "open the app" is noise.
   */
  linkHref?: string;
  /** Visible link text, e.g. `Open the invitation`. */
  linkLabel?: string;
  /** Text after `</a>`, e.g. ` to accept or decline.` */
  linkTrailing?: string;
  /** Gray footer sentence (expiry hint). */
  footer: string;
}

/**
 * Assemble the shared notification-email HTML shell (lead paragraph + link
 * action paragraph + gray footer).
 * @param shell - The per-email pieces (subject, lead, link, footer).
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
function renderNotificationMail(shell: NotificationMailShell): SendMailOptions {
  return {
    to: shell.to,
    subject: shell.subject,
    html: [
      `<p>${shell.leadHtml}</p>`,
      shell.linkHref
        ? `<p><a href="${escapeHtml(shell.linkHref)}">${shell.linkLabel}</a>${shell.linkTrailing ?? ""}</p>`
        : null,
      `<p style="color: #666; font-size: 90%;">${shell.footer}</p>`,
    ]
      .filter(Boolean)
      .join("\n      "),
  };
}

/** Fields for the studio invitation email. */
export interface StudioInvitationMailInput {
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
 * @param input - Invitee email, inviter + studio names, role, and the landing link.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildStudioInvitationMail(
  input: StudioInvitationMailInput,
): SendMailOptions {
  return renderNotificationMail({
    to: input.inviteeEmail,
    subject: `${BRAND} - ${input.inviterName} invited you to ${input.studioName}`,
    leadHtml: `<strong>${escapeHtml(input.inviterName)}</strong> invited you to join the studio <strong>${escapeHtml(input.studioName)}</strong> as <code>${escapeHtml(input.role)}</code>.`,
    linkHref: input.inviteLink,
    linkLabel: "Open the invitation",
    linkTrailing: " to accept or decline.",
    footer: expiryFooter("This invitation"),
  });
}

/** Fields for the project invitation email. */
export interface ProjectInvitationMailInput {
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
 * @param input - Invitee email, inviter + project names, role, and the landing link.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildProjectInvitationMail(
  input: ProjectInvitationMailInput,
): SendMailOptions {
  return renderNotificationMail({
    to: input.inviteeEmail,
    subject: `${BRAND} - ${input.inviterName} invited you to ${input.projectName}`,
    leadHtml: `<strong>${escapeHtml(input.inviterName)}</strong> invited you to collaborate on the project <strong>${escapeHtml(input.projectName)}</strong> as <code>${escapeHtml(input.role)}</code>.`,
    linkHref: input.inviteLink,
    linkLabel: "Open the invitation",
    linkTrailing: " to accept or decline.",
    footer: expiryFooter("This invitation"),
  });
}

/** Fields for the studio transfer-admin email. */
export interface StudioTransferMailInput {
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
 * @param input - Recipient email, initiator + studio names, and the app link.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildStudioTransferMail(
  input: StudioTransferMailInput,
): SendMailOptions {
  return renderNotificationMail({
    to: input.recipientEmail,
    subject: `${BRAND} - ${input.initiatorName} wants to transfer ${input.studioName} to you`,
    leadHtml: `<strong>${escapeHtml(input.initiatorName)}</strong> wants to make you the admin of the studio <strong>${escapeHtml(input.studioName)}</strong>.`,
    linkHref: input.decisionLink,
    linkLabel: "Review this transfer",
    linkTrailing: " to accept or decline.",
    footer: expiryFooter("This transfer request"),
  });
}

/** Fields for the project transfer-owner email. */
export interface ProjectTransferMailInput {
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
 * @param input - Recipient email, initiator + project names, and the app link.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildProjectTransferMail(
  input: ProjectTransferMailInput,
): SendMailOptions {
  return renderNotificationMail({
    to: input.recipientEmail,
    subject: `${BRAND} - ${input.initiatorName} wants to transfer ${input.projectName} to you`,
    leadHtml: `<strong>${escapeHtml(input.initiatorName)}</strong> wants to make you the owner of the project <strong>${escapeHtml(input.projectName)}</strong>.`,
    linkHref: input.decisionLink,
    linkLabel: "Review this transfer",
    linkTrailing: " to accept or decline.",
    footer: expiryFooter("This transfer request"),
  });
}

/** Fields for the role-upgrade request email, sent to the project's owner. */
export interface RoleUpgradeRequestMailInput {
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
 * This flow had no email at all until now — it existed only as a bell entry, so
 * an owner who was not in the app that week never learned there was a decision
 * waiting. The reason the requester typed is included because it is the whole
 * basis for the answer.
 * @param input - Recipient, names, requested role, reason and link.
 * @returns The mail options to send.
 */
export function buildRoleUpgradeRequestMail(
  input: RoleUpgradeRequestMailInput,
): SendMailOptions {
  const reason =
    input.message === null || input.message.trim() === ""
      ? ""
      : ` They said: <em>${escapeHtml(input.message)}</em>`;
  return renderNotificationMail({
    to: input.ownerEmail,
    subject: `${BRAND} - ${input.requesterName} asked for a bigger role on ${input.projectName}`,
    leadHtml: `<strong>${escapeHtml(input.requesterName)}</strong> asked to become <strong>${escapeHtml(input.requestedRole)}</strong> on <strong>${escapeHtml(input.projectName)}</strong>.${reason}`,
    linkHref: input.decisionLink,
    linkLabel: "Review this request",
    linkTrailing: " to approve or decline.",
    // Not "transfer request": nothing is changing hands, somebody is asking
    // for a bigger role on something that stays where it is.
    footer: expiryFooter("This request"),
  });
}

/** Fields for the membership-ended email. */
export interface MembershipEndedMailInput {
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
 * @param input - Recipient email and the tier that ended.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildMembershipEndedMail(
  input: MembershipEndedMailInput,
): SendMailOptions {
  return renderNotificationMail({
    to: input.recipientEmail,
    subject: `${BRAND} - your ${input.tierLabel} membership has ended`,
    leadHtml: `Your <strong>${escapeHtml(input.tierLabel)}</strong> membership has ended. Your account is on the free plan.`,
    footer: "Subscribe again at any time from the membership panel.",
  });
}

/** What the storage-full email needs. */
interface StorageQuotaExceededMailInput {
  /** Where to send it — the admin of the studio the write was aimed at. */
  recipientEmail: string;
  /** The studio that write was aimed at, for "where did this happen". */
  studioName: string;
}

/**
 * Build the storage-full email (#89).
 *
 * A notice, not a request: nothing is waiting to be answered, so no action
 * link and no deadline — `expiryFooter` would be about a decision window that
 * does not exist here.
 *
 * Says the ACCOUNT is full, not the studio. Storage is counted across every
 * studio the account administers, so naming only the studio would send the
 * reader to look at one that may hold hardly anything.
 * @param input - Recipient email and the studio the refused write was aimed at.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildStorageQuotaExceededMail(
  input: StorageQuotaExceededMailInput,
): SendMailOptions {
  return renderNotificationMail({
    to: input.recipientEmail,
    subject: `${BRAND} - your storage is full`,
    leadHtml:
      `Your storage is full, so uploads and generations were refused in ` +
      `<strong>${escapeHtml(input.studioName)}</strong>. Storage is counted ` +
      `across every studio you administer, not just this one.`,
    footer: "Raise your membership to get more room.",
  });
}
