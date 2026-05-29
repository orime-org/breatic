/**
 * Email content builders for access request + share link flows.
 *
 * Pure functions — input shape in, `SendMailOptions` out. The caller
 * (server route handler) dispatches via `sendMail()` and decides what
 * to log on the `SendMailResult`. This keeps `mailer.ts` infra-only
 * and the business templates centralized here.
 *
 * Per CLAUDE.md "core 和 shared 不写任何日志": these builders never
 * log; mail dispatch + audit log is the application layer's job.
 *
 * Content is EN hardcoded — matches the existing
 * `auth.service.forgotPassword` pattern (line 241). i18n for mail
 * templates is a follow-up once `users.preferred_locale` ships (no
 * locale column today means every user gets EN, so localizing here
 * would be premature optimization).
 *
 * Spec: engineering/specs/2026-05-26-deprecate-noaccount-email-auth-spec.md
 * § 6 user flows (E NOT_MEMBER + share dialog) define the four
 * notification points.
 */

import type { SendMailOptions } from "@core/infra/mailer.js";

const BRAND = "Breatic";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── 1. accessRequestCreated — sent to project owner ─────────────────

export interface AccessRequestCreatedMailInput {
  /** Project owner's email (recipient). */
  ownerEmail: string;
  /** Project owner's display name; falls back to email local-part. */
  ownerName?: string | null;
  /** Display name of the user making the request. */
  requesterName: string;
  /** Email of the user making the request. */
  requesterEmail: string;
  /** Project being requested. */
  projectName: string;
  /** Role the requester asked for ('edit' or 'view'). */
  requestedRole: string;
  /** Optional message attached to the request. */
  message?: string | null;
  /** Deep link to the project's BellMenu for one-click review. */
  reviewUrl: string;
}

/**
 * Build the email sent to the project owner when a new access
 * request lands.
 */
export function buildAccessRequestCreatedMail(
  input: AccessRequestCreatedMailInput,
): SendMailOptions {
  const requester = escapeHtml(input.requesterName);
  const requesterEmail = escapeHtml(input.requesterEmail);
  const project = escapeHtml(input.projectName);
  const role = escapeHtml(input.requestedRole);
  const messageBlock = input.message
    ? `<p><em>${escapeHtml(input.message)}</em></p>`
    : "";
  return {
    to: input.ownerEmail,
    subject: `${BRAND} — New access request for ${input.projectName}`,
    html: `
      <p><strong>${requester}</strong> (${requesterEmail}) requested access
        to your project <strong>${project}</strong> as <code>${role}</code>.</p>
      ${messageBlock}
      <p><a href="${escapeHtml(input.reviewUrl)}">Review the request</a></p>
    `.trim(),
  };
}

// ── 2. accessRequestApproved — sent to requester ───────────────────

export interface AccessRequestApprovedMailInput {
  /** Requester's email. */
  requesterEmail: string;
  /** Project they were approved for. */
  projectName: string;
  /** Deep link to the project so they can enter immediately. */
  projectUrl: string;
}

export function buildAccessRequestApprovedMail(
  input: AccessRequestApprovedMailInput,
): SendMailOptions {
  const project = escapeHtml(input.projectName);
  return {
    to: input.requesterEmail,
    subject: `${BRAND} — You're in: ${input.projectName}`,
    html: `
      <p>Your request to join <strong>${project}</strong> was approved.</p>
      <p><a href="${escapeHtml(input.projectUrl)}">Open ${project}</a></p>
    `.trim(),
  };
}

// ── 3. accessRequestRejected — sent to requester ───────────────────

export interface AccessRequestRejectedMailInput {
  requesterEmail: string;
  projectName: string;
}

export function buildAccessRequestRejectedMail(
  input: AccessRequestRejectedMailInput,
): SendMailOptions {
  const project = escapeHtml(input.projectName);
  return {
    to: input.requesterEmail,
    subject: `${BRAND} — Access request decision`,
    html: `
      <p>Your request to join <strong>${project}</strong> was not approved.</p>
      <p>You can submit a new request later, or contact the project owner
        for more context.</p>
    `.trim(),
  };
}

// ── 4. shareInvite — sent to invitee when owner uses ShareDialog ────

export interface ShareInviteMailInput {
  inviteeEmail: string;
  /** Display name of the user sending the invite. */
  inviterName: string;
  projectName: string;
  /** Full invite URL (e.g. https://breatic.ai/invite/<token>). */
  inviteLink: string;
  /** Role the invitee will be granted on accept ('edit' or 'view'). */
  role: string;
}

/**
 * Email-invite mail. Email-invite links are always single-use + bound
 * to this recipient's email + expire in 7 days
 * (spec 2026-05-28 § 3). Generate links are NOT sent via email — owner
 * copies the URL manually — so this mail builder doesn't need a
 * variant for them.
 */
export function buildShareInviteMail(input: ShareInviteMailInput): SendMailOptions {
  const inviter = escapeHtml(input.inviterName);
  const project = escapeHtml(input.projectName);
  const role = escapeHtml(input.role);
  return {
    to: input.inviteeEmail,
    subject: `${BRAND} — ${input.inviterName} invited you to ${input.projectName}`,
    html: `
      <p><strong>${inviter}</strong> invited you to collaborate on
        <strong>${project}</strong> as <code>${role}</code>.</p>
      <p><a href="${escapeHtml(input.inviteLink)}">Accept the invite</a></p>
      <p style="color: #666; font-size: 90%;">This invite is single-use and expires in 7 days.</p>
    `.trim(),
  };
}
