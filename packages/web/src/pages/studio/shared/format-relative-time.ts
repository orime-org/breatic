// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { useTranslation } from '@web/i18n/use-translation';

/** The translation function shape (from `useTranslation`). */
type Translate = ReturnType<typeof useTranslation>;

/**
 * Format an ISO timestamp as a localized relative-time label ("just now",
 * "5 minutes ago", "2 days ago" — i18n via the shared `chat.relative.*` keys),
 * falling back to the locale date beyond ~30 days or for invalid input. Shared
 * by the project card (last modified) and the recent card (last opened) so both
 * read identically across locales.
 * @param iso - the ISO-8601 timestamp.
 * @param t - the translation function.
 * @param now - current epoch ms (injectable so tests are deterministic).
 * @returns the localized relative-time label.
 */
export function formatRelativeTime(
  iso: string,
  t: Translate,
  now: number = Date.now(),
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
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
  return new Date(iso).toLocaleDateString();
}
