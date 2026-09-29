// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The HTML every product email is assembled into, and how a catalog message
 * becomes a piece of it.
 *
 * Every sentence comes from `server.mail.*` in the locale catalogs and is
 * rendered in the recipient's language by the builder that wraps it in
 * `runWithLocale`. Markup comes only from the catalog: `<b>`, `<code>`, `<em>`
 * and `<a>` are tags there, and every parameter is escaped before it is
 * inserted, so a name carrying `<b>` or `&` shows as those characters.
 */

import type { SendMailOptions } from "@breatic/core";
import { t, tRich } from "@breatic/shared";

const BRAND = "Breatic";

/**
 * Escape HTML-significant chars in user-supplied strings (XSS-safe email body).
 * @param s - The raw user-supplied string to escape.
 * @returns The string with `& < > " '` replaced by their HTML entities.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a catalog message as HTML in the current locale.
 * @param key - A `server.mail.*` key.
 * @param params - Its placeholders; strings are escaped once, numbers pass through.
 * @param href - Where the message's `<a>` tag links to, when it has one.
 * @returns The HTML fragment.
 */
export function mailHtml(
  key: string,
  params: Record<string, string | number> = {},
  href?: string,
): string {
  const escaped = Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      typeof value === "string" ? escapeHtml(value) : value,
    ]),
  );
  return tRich(key, escaped, {
    b: (chunks) => `<strong>${chunks.join("")}</strong>`,
    code: (chunks) => `<code>${chunks.join("")}</code>`,
    em: (chunks) => `<em>${chunks.join("")}</em>`,
    a: (chunks) => `<a href="${escapeHtml(href ?? "")}">${chunks.join("")}</a>`,
  });
}

/**
 * Render a catalog message as a subject line in the current locale.
 * @param key - A `server.mail.*` subject key.
 * @param params - Its placeholders, inserted as plain text (a header, not HTML).
 * @returns The subject, prefixed with the brand.
 */
export function mailSubject(key: string, params: Record<string, string> = {}): string {
  return `${BRAND} - ${t(key, params)}`;
}

/** The pieces every product email shares — assembled by {@link renderMail}. */
export interface MailShell {
  /** Recipient address. */
  to: string;
  /** Plain-text subject line. */
  subject: string;
  /** HTML of the lead paragraph. */
  leadHtml: string;
  /** HTML of the action paragraph; absent on a notice with nothing to do. */
  actionHtml?: string;
  /** HTML of the gray footer sentence. */
  footerHtml: string;
}

/**
 * Assemble the shared email HTML (lead paragraph, optional action paragraph,
 * gray footer).
 * @param shell - The per-email pieces.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function renderMail(shell: MailShell): SendMailOptions {
  return {
    to: shell.to,
    subject: shell.subject,
    html: [
      `<p>${shell.leadHtml}</p>`,
      shell.actionHtml === undefined ? null : `<p>${shell.actionHtml}</p>`,
      `<p style="color: #666; font-size: 90%;">${shell.footerHtml}</p>`,
    ]
      .filter(Boolean)
      .join("\n      "),
  };
}
