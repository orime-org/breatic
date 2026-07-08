// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project transfer-owner email template (#1611).
 *
 * Pure HTML builder: escape every user-supplied field (XSS) and return
 * `SendMailOptions` for the route to hand to `sendMail`. The email is an
 * OPTIONAL enhancement — the bell notification is the always-delivered path;
 * this only fires when an SMTP backend is configured. Confirmation happens in
 * the bell (there is no token landing page for a transfer), so the mail just
 * points the recipient at the app.
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

/** Fields for the project transfer-owner email. */
export interface ProjectTransferMailInput {
  recipientEmail: string;
  initiatorName: string;
  projectName: string;
  /** Link back into the app, e.g. `https://breatic.ai/project/<slug>-<id>`. */
  projectLink: string;
}

/**
 * Build the project transfer-owner email — the recipient accepts / declines from
 * their bell notifications (there is no token landing page for a transfer).
 * @param input - Recipient email, initiator + project names, and the app link
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`
 */
export function buildProjectTransferMail(
  input: ProjectTransferMailInput,
): SendMailOptions {
  const initiator = escapeHtml(input.initiatorName);
  const project = escapeHtml(input.projectName);
  return {
    to: input.recipientEmail,
    subject: `${BRAND} - ${input.initiatorName} wants to transfer ${input.projectName} to you`,
    html: `
      <p><strong>${initiator}</strong> wants to make you the owner of the project
        <strong>${project}</strong>.</p>
      <p><a href="${escapeHtml(input.projectLink)}">Open ${BRAND}</a> and check your notifications to accept or decline.</p>
      <p style="color: #666; font-size: 90%;">This transfer request expires in 7 days. If you didn't expect it, you can ignore this email.</p>
    `.trim(),
  };
}
