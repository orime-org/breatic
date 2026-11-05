// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two upload-mark sentences a canvas text node shows when its extracted
 * text is not written because the Space is out of room (inner#1790 doc-sync
 * checks D-09, and D-07 for these two messages).
 *
 * The key names are the implementation's to choose, so each key is found by
 * its exact English text; the other four catalogs are then read at that key.
 * The Chinese text is data the spec fixes, which is why CJK appears here.
 */

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

const [, EN] = LOCALE_CATALOGS[0];

/**
 * Every string leaf of a catalog, as dotted path and message.
 * @param node - A parsed catalog or a subtree of it.
 * @param prefix - The dotted path to `node`.
 * @returns The leaves.
 */
function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key),
  );
}

/**
 * The ICU argument names a plain message uses.
 * @param message - The message text.
 * @returns The sorted, de-duplicated names.
 */
function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map((match) => match[1]))].sort();
}

const MESSAGES = [
  {
    name: 'no_room',
    en: 'Text not added: this doesn\'t fit — the Space has {room} left.',
    zhCN: '文字没有写入：放不下，这个 Space 只剩 {room}。',
    args: ['room'],
  },
  {
    name: 'full',
    en: 'Text not added: this Space is full.',
    zhCN: '文字没有写入：这个 Space 已满。',
    args: [],
  },
] as const;

describe.each(MESSAGES)('the text node upload mark for $name', ({ en, zhCN, args }) => {
  const keys = leaves(EN)
    .filter(([, message]) => message === en)
    .map(([key]) => key);

  it('has exactly one English key with the agreed text', () => {
    expect(keys).toHaveLength(1);
  });

  it('has the agreed Simplified Chinese text at that key', () => {
    const [, zh] = LOCALE_CATALOGS.find(([tag]) => tag === 'zh-CN')!;
    expect(readPath(zh, keys[0] ?? '')).toBe(zhCN);
  });

  it.each(LOCALE_CATALOGS.map(([tag, catalog]) => [tag, catalog] as const))(
    'is a non-empty message with the agreed placeholders in %s',
    (_tag, catalog) => {
      const message = readPath(catalog, keys[0] ?? '');
      expect(typeof message).toBe('string');
      expect((message as string).trim().length).toBeGreaterThan(0);
      expect(placeholders(message as string)).toEqual([...args]);
    },
  );

  it.each(
    LOCALE_CATALOGS.filter(([tag]) => tag !== 'en').map(([tag, catalog]) => [tag, catalog] as const),
  )('keeps the product noun Space untranslated in %s', (_tag, catalog) => {
    expect(readPath(catalog, keys[0] ?? '')).toEqual(expect.stringContaining('Space'));
  });
});
