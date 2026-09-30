// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account mails: the password-reset mail, which carries a one-time token
 * link, and the sign-up code mail (#287), which carries a six-digit code —
 * both rendered in the recipient's language from the `server.mail.*` catalog
 * entries.
 *
 * These are the primary delivery channel for their flows — there is no bell
 * row behind them — so the service sends them directly and reports the result
 * to its caller rather than going through the best-effort path.
 */

import { renderMail, type RenderedMail } from "@server/utils/mail-shell.js";

const SECONDS_PER_HOUR = 3600;

/** Fields for the password-reset mail. */
export interface PasswordResetMailInput {
  /** The account's language. */
  locale: string;
  to: string;
  /** The link that carries the one-time token. */
  url: string;
  /** How long that token lives. */
  expiresInSeconds: number;
}

/**
 * Build the password-reset mail. The button is labelled with words: Aliyun
 * DirectMail refuses a message whose link text is the bare address
 * ("554 Reject by content spam").
 * @param input - The account's language and address, the token link, and its lifetime.
 * @returns The laid-out mail (to / subject / html / text) for `sendMail`.
 */
export function buildPasswordResetMail(input: PasswordResetMailInput): Promise<RenderedMail> {
  const section = "server.mail.password_reset";
  return renderMail(input.locale, {
    to: input.to,
    subject: { key: `${section}.subject` },
    body: [{ key: `${section}.lead` }],
    action: { label: { key: `${section}.action` }, href: input.url },
    note: {
      key: `${section}.footer`,
      params: { hours: Math.round(input.expiresInSeconds / SECONDS_PER_HOUR) },
    },
  });
}

const SECONDS_PER_MINUTE = 60;

/** The code block: large, monospaced and spaced so it reads at a glance and copies as one run. */
const CODE_BLOCK_STYLE =
  "margin:20px 0 0;padding:16px 0;text-align:center;font-family:ui-monospace,Menlo,Consolas,monospace;" +
  "font-size:32px;font-weight:600;line-height:1;letter-spacing:8px;color:#1e1e1e;background:#f0f0f0;border-radius:8px;";

/** Fields for the sign-up code mail. */
export interface SignupCodeMailInput {
  /** The language the sign-up was made in. */
  locale: string;
  to: string;
  /** The six-digit code. */
  code: string;
  /** How long the code lives. */
  expiresInSeconds: number;
}

/**
 * Build the mail that carries a sign-up code. It has no button: the reader
 * types the code into the page they signed up on.
 * @param input - The language and address, the code, and its lifetime.
 * @returns The laid-out mail (to / subject / html / text) for `sendMail`.
 */
export function buildSignupCodeMail(input: SignupCodeMailInput): Promise<RenderedMail> {
  const section = "server.mail.signup_code";
  return renderMail(input.locale, {
    to: input.to,
    subject: { key: `${section}.subject` },
    body: [{ key: `${section}.lead` }],
    details: { html: `<div style="${CODE_BLOCK_STYLE}">${input.code}</div>`, text: input.code },
    note: {
      key: `${section}.footer`,
      params: { minutes: Math.round(input.expiresInSeconds / SECONDS_PER_MINUTE) },
    },
  });
}
