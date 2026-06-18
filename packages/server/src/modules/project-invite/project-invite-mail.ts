// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project invitation email template (invite-confirm handshake, 2026-06-18,
 * #1337).
 *
 * Pure HTML builder mirroring `studio-invite-mail`: escape every user-supplied
 * field (XSS) and return `SendMailOptions` for the route to hand to `sendMail`.
 * The email is an OPTIONAL enhancement — the bell notification is the always-
 * delivered path; this only fires when an SMTP backend is configured.
 */

import type { SendMailOptions } from "@server/infra/mailer.js";

const BRAND = "Breatic";

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

/** Fields for the project invitation email. */
export interface ProjectInvitationMailInput {
  inviteeEmail: string;
  inviterName: string;
  projectName: string;
  role: string;
  /** Full landing link, e.g. `https://breatic.ai/project-invite?token=<token>`. */
  inviteLink: string;
}

/**
 * Build the project invitation email — the invitee opens the link and lands on
 * a confirm/decline page (NOT auto-accept), mirroring the bell action.
 * @param input - Invitee email, inviter + project names, role, and the landing link
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`
 */
export function buildProjectInvitationMail(
  input: ProjectInvitationMailInput,
): SendMailOptions {
  const inviter = escapeHtml(input.inviterName);
  const project = escapeHtml(input.projectName);
  const role = escapeHtml(input.role);
  return {
    to: input.inviteeEmail,
    subject: `${BRAND} - ${input.inviterName} invited you to ${input.projectName}`,
    html: `
      <p><strong>${inviter}</strong> invited you to collaborate on the project
        <strong>${project}</strong> as <code>${role}</code>.</p>
      <p><a href="${escapeHtml(input.inviteLink)}">Open the invitation</a> to accept or decline.</p>
      <p style="color: #666; font-size: 90%;">This invitation expires in 7 days. If you didn't expect it, you can ignore this email.</p>
    `.trim(),
  };
}
