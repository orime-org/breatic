/**
 * Email content builder for the share-invite flow.
 *
 * Pure function — input shape in, `SendMailOptions` out. The caller
 * (server route handler) dispatches via `sendMail()` and decides what
 * to log on the `SendMailResult`. This keeps `mailer.ts` infra-only
 * and the business template centralized here.
 *
 * Per CLAUDE.md "core 和 shared 不写任何日志": this builder never
 * logs; mail dispatch + audit log is the application layer's job.
 *
 * Content is EN hardcoded — matches the existing
 * `auth.service.forgotPassword` pattern. i18n for mail templates is a
 * follow-up once `users.preferred_locale` ships.
 *
 * Spec: engineering/specs/2026-05-28-access-permission-design.md § 3
 * (owner-invite-only model — the only mail in this flow is the
 * email-invite the owner sends via ShareDialog).
 */

import type { SendMailOptions } from "@server/infra/mailer.js";

const BRAND = "Breatic";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
