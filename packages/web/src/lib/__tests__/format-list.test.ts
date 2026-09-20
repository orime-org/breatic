// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Naming several things inside one sentence (#2175).
 *
 * The things named are format names, which are the same word everywhere; what
 * differs by language is how a list of them is strung together, and a list
 * strung together in English inside a Chinese sentence reads as a mistake.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLocale: vi.fn(() => 'en'),
}));

import { getLocale } from '@breatic/shared';

import { formatList } from '@web/lib/format-list';

describe('naming several things in one sentence', () => {
  it('strings them together the way the reader’s language does', () => {
    vi.mocked(getLocale).mockReturnValue('en');
    expect(formatList(['png', 'jpeg', 'gif'])).toBe('png, jpeg, and gif');

    vi.mocked(getLocale).mockReturnValue('zh-CN');
    const zh = formatList(['png', 'jpeg', 'gif']);
    expect(zh).toContain('、');
    expect(zh).not.toContain('and');
  });

  it('names one thing as itself', () => {
    vi.mocked(getLocale).mockReturnValue('en');
    expect(formatList(['mp3'])).toBe('mp3');
  });
});
