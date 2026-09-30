// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two account mails that carry a one-time token link — password reset and
 * email verification — rendered in the recipient's language from the
 * `server.mail.*` catalog entries.
 *
 * These are the primary delivery channel for their flows — there is no bell
 * row behind them — so the service sends them directly and reports the result
 * to its caller rather than going through the best-effort path.
 */

import { renderMail, type RenderedMail } from "@server/utils/mail-shell.js";

const SECONDS_PER_HOUR = 3600;

/** Which token mail; also its `server.mail.*` catalog section. */
export type TokenLinkMailKind = "password_reset" | "email_verification";

/** Fields for a token-link mail. */
export interface TokenLinkMailInput {
  /** The account's language. */
  locale: string;
  to: string;
  /** The link that carries the one-time token. */
  url: string;
  /** How long that token lives. */
  expiresInSeconds: number;
}

/**
 * Build a token-link mail. The button is labelled with words: Aliyun
 * DirectMail refuses a message whose link text is the bare address
 * ("554 Reject by content spam").
 * @param kind - Password reset or email verification.
 * @param input - The account's language and address, the token link, and its lifetime.
 * @returns The laid-out mail (to / subject / html / text) for `sendMail`.
 */
export function buildTokenLinkMail(
  kind: TokenLinkMailKind,
  input: TokenLinkMailInput,
): Promise<RenderedMail> {
  const section = `server.mail.${kind}`;
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
