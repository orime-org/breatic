// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Password-reset and email-verification templates, rendered in the
 * recipient's language from the `server.mail.*` catalog entries.
 *
 * These are the primary delivery channel for their flows — there is no bell
 * row behind them — so the service sends them directly and reports the result
 * to its caller rather than going through the best-effort path.
 */

import { runWithLocale, type SendMailOptions } from "@breatic/core";
import { escapeHtml, mailHtml, mailSubject, renderMail } from "@server/utils/mail-shell.js";

const SECONDS_PER_HOUR = 3600;

/** Fields for the password-reset email. */
export interface PasswordResetMailInput {
  /** The account's language. */
  locale: string;
  to: string;
  /** The link that carries the one-time reset token. */
  resetUrl: string;
  /** How long that token lives. */
  expiresInSeconds: number;
}

/**
 * Build the password-reset email.
 * @param input - The account's language and address, the reset link, and its lifetime.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildPasswordResetMail(input: PasswordResetMailInput): SendMailOptions {
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.to,
      subject: mailSubject("server.mail.password_reset.subject"),
      leadHtml: mailHtml("server.mail.password_reset.lead"),
      actionHtml: mailHtml("server.mail.password_reset.action", {}, input.resetUrl),
      footerHtml: mailHtml("server.mail.password_reset.footer", {
        hours: Math.round(input.expiresInSeconds / SECONDS_PER_HOUR),
      }),
    }),
  );
}

/** Fields for the email-verification email. */
export interface EmailVerificationMailInput {
  /** The account's language. */
  locale: string;
  to: string;
  /** The link that carries the one-time verification token. */
  verifyUrl: string;
  /** How long that token lives. */
  expiresInSeconds: number;
}

/**
 * Build the email-verification email. The link is shown as its own address so
 * a reader whose client strips links can still copy it.
 * @param input - The account's language and address, the verification link, and its lifetime.
 * @returns `SendMailOptions` (to / subject / html) for `sendMail`.
 */
export function buildEmailVerificationMail(input: EmailVerificationMailInput): SendMailOptions {
  const url = escapeHtml(input.verifyUrl);
  return runWithLocale(input.locale, () =>
    renderMail({
      to: input.to,
      subject: mailSubject("server.mail.email_verification.subject"),
      leadHtml: mailHtml("server.mail.email_verification.lead"),
      actionHtml: `<a href="${url}">${url}</a>`,
      footerHtml: mailHtml("server.mail.email_verification.footer", {
        hours: Math.round(input.expiresInSeconds / SECONDS_PER_HOUR),
      }),
    }),
  );
}
