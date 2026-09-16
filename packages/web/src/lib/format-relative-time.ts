// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { getLocale } from '@breatic/shared';

import type { useTranslation } from '@web/i18n/use-translation';

/** The translation function shape (from `useTranslation`). */
type Translate = ReturnType<typeof useTranslation>;

/**
 * Format a timestamp as a localized relative-time label ("just now",
 * "5 minutes ago", "2 days ago" — i18n via the shared `chat.relative.*` keys),
 * falling back to the date beyond ~30 days or handing back unreadable input.
 *
 * The one label every surface uses: the Project card's last-modified, the
 * recent card's last-opened, and an annotation's posted-at. The sticky used to
 * carry a second copy that spoke English whatever the language switch said
 * (#2155) — a formatter that lives beside one caller is a formatter only that
 * caller's locale ever reaches.
 *
 * Takes either form the callers hold: an ISO string off the wire, or the epoch
 * milliseconds a canvas node stores.
 * @param at - The ISO-8601 timestamp, or epoch milliseconds.
 * @param t - The translation function.
 * @param now - Current epoch ms (injectable so tests are deterministic).
 * @returns The localized relative-time label.
 */
export function formatRelativeTime(
  at: string | number,
  t: Translate,
  now: number = Date.now(),
): string {
  const then = typeof at === 'number' ? at : new Date(at).getTime();
  // A string we cannot read goes back as it came — it is the only thing left to
  // show. A number we cannot read has nothing to show, so nothing is shown:
  // printing `NaN` on a sticky says less than an empty line does.
  if (!Number.isFinite(then)) return typeof at === 'number' ? '' : at;
  const diff = now - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('chat.relative.justNow');
  if (diff < hour) {
    return t('chat.relative.minutesAgo', { count: Math.floor(diff / minute) });
  }
  if (diff < day) {
    return t('chat.relative.hoursAgo', { count: Math.floor(diff / hour) });
  }
  if (diff < 30 * day) {
    return t('chat.relative.daysAgo', { count: Math.floor(diff / day) });
  }
  // The language switch decides, not the browser: a reader who set the app to
  // Chinese and gets `8/9/2025` is reading someone else's date order.
  return new Date(then).toLocaleDateString(getLocale());
}
