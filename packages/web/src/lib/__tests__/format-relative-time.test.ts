// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '@breatic/shared';

import { formatRelativeTime } from '@web/lib/format-relative-time';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

/**
 * Stand-in for the translation function, echoing the key and its count so an
 * assertion can name which branch answered.
 * @param key - The i18n key.
 * @param vars - The interpolation values.
 * @returns The key, with the count appended when there is one.
 */
const t = ((key: string, vars?: { count?: number }): string =>
  vars?.count === undefined
    ? key
    : `${key}:${vars.count}`) as unknown as Parameters<
  typeof formatRelativeTime
>[1];

describe('the relative-time label every surface shares', () => {
  afterEach(() => {
    setLocale('en');
  });

  it('takes an epoch, the way a canvas node stores its time', () => {
    // Annotations keep `createdAt` as epoch milliseconds. Before #1881 the
    // sticky carried its own formatter for exactly that reason, and it spoke
    // English whatever the language switch said.
    expect(formatRelativeTime(NOW - 5 * 60_000, t, NOW)).toBe(
      'chat.relative.minutesAgo:5',
    );
    expect(formatRelativeTime(NOW - 3 * 3_600_000, t, NOW)).toBe(
      'chat.relative.hoursAgo:3',
    );
    expect(formatRelativeTime(NOW - 2 * 86_400_000, t, NOW)).toBe(
      'chat.relative.daysAgo:2',
    );
    expect(formatRelativeTime(NOW - 1_000, t, NOW)).toBe(
      'chat.relative.justNow',
    );
  });

  it('still takes the ISO string the cards pass it', () => {
    expect(
      formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), t, NOW),
    ).toBe('chat.relative.minutesAgo:5');
  });

  it('formats the far-past date in the language the user chose', () => {
    // Past ~30 days it falls back to a date, and a date read by a person is a
    // date in their language — the switch says which, not the browser.
    const old = NOW - 400 * 86_400_000;
    setLocale('zh-CN');
    const chinese = formatRelativeTime(old, t, NOW);
    setLocale('en');
    const english = formatRelativeTime(old, t, NOW);
    expect(chinese).toBe(new Date(old).toLocaleDateString('zh-CN'));
    expect(english).toBe(new Date(old).toLocaleDateString('en'));
    expect(chinese).not.toBe(english);
  });

  it('hands back unreadable input unchanged rather than inventing a date', () => {
    expect(formatRelativeTime('not a date', t, NOW)).toBe('not a date');
    expect(formatRelativeTime(Number.NaN, t, NOW)).toBe('');
  });
});
