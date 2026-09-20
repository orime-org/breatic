// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The wording a buyer agrees to, and the version it was agreed at.
 *
 * Two texts reach a buyer at checkout and both are evidence: what they tick
 * on our own confirm dialog, and the refund rule the confirmation repeats. Both will
 * be reworded — the refund window was fifteen days before it was thirty — so
 * a purchase records the version it was made under, and the version names the
 * key its wording lives at.
 *
 * The version IS the key's last segment. Reading back what a two-year-old
 * purchase agreed to is then a lookup, with nothing in between to drift: a
 * reworded text becomes `…-v2` alongside, and `…-v1` stays in every locale
 * file forever. Both readers take the version rather than assuming today's,
 * which is what makes a confirmation resent next year say what that purchase
 * actually agreed to.
 *
 * The refund rule itself was settled on 2026-07-31: thirty UTC calendar days
 * from payment, full refund only while nothing in the pack has been spent,
 * one refund per purchase, and — since a pack is spent by the Studio it is
 * pointed at — nothing pointed at a Studio can be asked about until it is
 * released. Three of those four lines are the pricing page's wording verbatim;
 * the condition about assignment is stated in-app and at checkout only.
 */

import { t } from "@breatic/shared";
import { runWithLocale } from "@breatic/core";
import type { Locale } from "@breatic/shared";

/** The consent wording a credit purchase made today is made under. */
export const CONSENT_CREDITS_VERSION = "consent-credits-v2";

/** The refund rule a credit purchase made today is made under. */
export const REFUND_CREDITS_VERSION = "refund-credits-v2";

/**
 * Which lines each version of the refund rule is made of.
 *
 * A version's line count is part of that version: v1 stated three answers,
 * v2 states those three and the condition a buyer meets first. Reading a
 * stored version through today's list would print a purchase a clause it
 * never agreed to.
 */
const REFUND_LINE_KEYS: Readonly<Record<string, readonly string[]>> = {
  "refund-credits-v1": ["unused", "used", "expired"],
  "refund-credits-v2": ["unused", "used", "expired", "unassigned"],
};

/**
 * The consent wording one purchase was made under, in the language it was
 * made in.
 * @param version - Which wording, as recorded on the payment.
 * @param locale - The language the buyer bought in.
 * @returns The wording, ready to put on the confirm dialog or to print in an
 *   email.
 */
export function consentTextAt(version: string, locale: Locale): string {
  return runWithLocale(locale, () => t(`server.payment.${version}`));
}

/**
 * The refund rule one purchase was made under, in the language it was made in.
 *
 * The answers come first, so a buyer reading this before they buy can see
 * which one would be theirs: spent nothing inside thirty days, spent
 * something, or past thirty days. The condition that holds throughout comes
 * last, where it reads as what it is — a step before asking, not the thing
 * they came to find out. A pack assigned to a Studio is that Studio's to
 * spend, and the buyer releases it before asking about it.
 * The first three appear on the pricing page in the same words.
 *
 * A version this build does not know falls back to today's line list, which
 * makes each missing key come back as the key itself — loud, and caught by
 * the guard that walks every published version against every locale file
 * (`purchase-mail-template.integration.test.ts`).
 * @param version - Which rule, as recorded on the payment.
 * @param locale - The language the buyer bought in.
 * @returns The lines, in the order they are read.
 */
export function refundLinesAt(
  version: string,
  locale: Locale,
): readonly string[] {
  const keys =
    REFUND_LINE_KEYS[version] ?? REFUND_LINE_KEYS[REFUND_CREDITS_VERSION]!;
  return runWithLocale(locale, () =>
    keys.map((key) => t(`server.payment.${version}.${key}`)),
  );
}
