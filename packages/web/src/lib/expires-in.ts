// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The countdown every time-boxed request shows.
 *
 * A deferred request — a role upgrade, an ownership offer, an invite — dies on
 * its deadline whether or not anyone acted, so both sides need to see how long
 * is left: the person deciding, in their bell, and the person waiting, on the
 * surface that lets them withdraw. One formatter, so those two never disagree
 * about what "3 days left" means.
 */

import type { useTranslation } from '@web/i18n/use-translation';

/**
 * Format the time left until a deadline as a coarse "expires in Nd/Nh/Nm"
 * label, or "expired" once past.
 *
 * Coarse on purpose: the deadline is a week away, so a ticking second counter
 * would be noise, and rounding keeps the label stable between renders.
 * @param expiresAt - ISO timestamp of when the request stops being answerable.
 * @param t - Translation function for the localized label.
 * @returns The localized countdown label.
 */
export function expiresInLabel(
  expiresAt: string,
  t: ReturnType<typeof useTranslation>,
): string {
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return t('notifications.expiresLabel.expired');
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) {
    return t('notifications.expiresLabel.minutes', { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t('notifications.expiresLabel.hours', { count: hours });
  }
  const days = Math.round(hours / 24);
  return t('notifications.expiresLabel.days', { count: days });
}
