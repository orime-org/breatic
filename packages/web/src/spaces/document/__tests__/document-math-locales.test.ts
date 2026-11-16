// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 design §10: the six strings the formula puts on screen, in all
 * five catalogs. A missing one falls back to English without a sound, so this
 * counts them. `LaTeX` is a format's name and stays in Latin letters in every
 * language.
 */

import { describe, it, expect } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

const KEYS = [
  'spaces.document.commands.formula',
  'spaces.document.math.placeholder',
  'spaces.document.math.empty',
  'spaces.document.math.error',
  'spaces.document.math.blank',
  'spaces.document.math.ok',
] as const;

describe('the formula strings', () => {
  LOCALE_CATALOGS.forEach(([tag, catalog]) => {
    KEYS.forEach((key) => {
      it(`${tag} carries ${key}`, () => {
        const value = readPath(catalog, key);
        expect(typeof value).toBe('string');
        expect(value).not.toBe('');
      });
    });

    it(`${tag} keeps LaTeX in Latin letters in the placeholder`, () => {
      expect(readPath(catalog, 'spaces.document.math.placeholder')).toContain('LaTeX');
    });
  });
});
