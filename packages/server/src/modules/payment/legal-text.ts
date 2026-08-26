// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The wording a buyer agrees to, and the version it was agreed at.
 *
 * Two texts reach a buyer at checkout and both are evidence: what they tick
 * on the Stripe page, and the refund rule the confirmation email repeats. Both
 * will be reworded — the refund window was fifteen days before it was thirty —
 * so a purchase records the version it was made under, and the version names
 * the key its wording lives at.
 *
 * The version IS the key's last segment. Reading back what a two-year-old
 * purchase agreed to is then a lookup, with nothing in between to drift: a
 * reworded text becomes `…-v2` alongside, and `…-v1` stays in every locale
 * file forever.
 */

import { t } from "@breatic/shared";
import { runWithLocale } from "@breatic/core";
import type { Locale } from "@breatic/shared";

/** The consent wording a credit purchase is made under. */
export const CONSENT_CREDITS_VERSION = "consent-credits-v1";

/** The refund rule a credit purchase is made under. */
export const REFUND_CREDITS_VERSION = "refund-credits-v1";

/**
 * The consent wording for a credit purchase, in one particular language.
 *
 * Takes the locale rather than reading the ambient one: a resend from another
 * device has to reproduce the language the purchase was made in, and that is
 * on the payment, not on the request.
 * @param locale - The language the buyer bought in.
 * @returns The wording, ready to hand to Stripe or to print in an email.
 */
export function creditsConsentText(locale: Locale): string {
  return runWithLocale(locale, () =>
    t(`server.payment.${CONSENT_CREDITS_VERSION}`),
  );
}
