// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The six strings the link control puts on screen, in all five catalogs.
 *
 * A missing one falls back to English (`t()` in `@breatic/shared`: current
 * locale, then English, then the key itself), so a reader who set the product
 * to Japanese gets an English word in the middle of a Japanese panel and
 * nothing reports it. Only a key missing from English too renders as a dotted
 * string. Nothing else would notice either way: a catalog short one entry
 * breaks no type and fails no other test, so it takes someone counting.
 *
 * The button's name sits under `commands` with the bubble bar's other ten
 * controls — the eight commands plus the two entries that are not open yet;
 * the five inside the panel form their own group. The first answers
 * "what is this button called", the rest are this panel's own words.
 */

import { describe, it, expect } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

const KEYS = [
  'spaces.document.commands.link',
  'spaces.document.link.placeholder',
  'spaces.document.link.confirm',
  'spaces.document.link.edit',
  'spaces.document.link.remove',
  'spaces.document.link.invalid',
] as const;

describe('the link control strings', () => {
  LOCALE_CATALOGS.forEach(([tag, catalog]) => {
    KEYS.forEach((key) => {
      it(`${tag} carries ${key}`, () => {
        const value = readPath(catalog, key);

        expect(typeof value).toBe('string');
        expect(value).not.toBe('');
      });
    });
  });

  it('gives no two catalogs the same wording for one key', () => {
    // Five of the six are ordinary words, so a collision means one catalog was
    // copied from another. Japanese and Korean share no such form with either
    // Chinese variant, and English shares none with any of them.
    const perKey = KEYS.map((key) =>
      LOCALE_CATALOGS.map(([, catalog]) => readPath(catalog, key)),
    );

    perKey.forEach((values, index) => {
      expect(new Set(values).size, `${KEYS[index]} has a repeated translation`).toBe(
        LOCALE_CATALOGS.length,
      );
    });
  });
});
