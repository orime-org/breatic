// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Notification email templates (studio / project invitations + transfers).
 *
 * These four builders are best-effort NOTIFICATION emails: the bell
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

import type { SendMailOptions } from "@server/infra/mailer.js";

const BRAND = "Breatic";
const INVITE_FOOTER =
  "This invitation expires in 7 days. If you didn't expect it, you can ignore this email.";
const TRANSFER_FOOTER =
  "This transfer request expires in 7 days. If you didn't expect it, you can ignore this email.";

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
  /** Raw link target — escaped into the `href` attribute here. */
  linkHref: string;
  /** Visible link text, e.g. `Open the invitation`. */
  linkLabel: string;
  /** Text after `</a>`, e.g. ` to accept or decline.` */
  linkTrailing: string;
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
    html: `
      <p>${shell.leadHtml}</p>
      <p><a href="${escapeHtml(shell.linkHref)}">${shell.linkLabel}</a>${shell.linkTrailing}</p>
      <p style="color: #666; font-size: 90%;">${shell.footer}</p>
    `.trim(),
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
 * Build the studio invitation email — the invitee opens the link and lands on a
 * confirm/decline page (NOT auto-accept), mirroring the bell action.
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
    footer: INVITE_FOOTER,
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
 * a confirm/decline page (NOT auto-accept), mirroring the bell action.
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
    footer: INVITE_FOOTER,
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
 * their bell notifications (there is no token landing page for a transfer).
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
    footer: TRANSFER_FOOTER,
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
 * their bell notifications (there is no token landing page for a transfer).
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
    footer: TRANSFER_FOOTER,
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
    footer: TRANSFER_FOOTER,
  });
}
