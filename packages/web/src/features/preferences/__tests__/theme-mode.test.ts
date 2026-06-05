// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  THEME_MODES,
  resolveTheme,
} from '@web/features/preferences/theme-mode';
import { SUPPORTED_LANGS } from '@web/features/preferences/supported-langs';

describe('preferences shared core', () => {
  describe('resolveTheme', () => {
    it('passes explicit light / dark through unchanged', () => {
      expect(resolveTheme('light')).toBe('light');
      expect(resolveTheme('dark')).toBe('dark');
    });

    it('resolves system via the prefers-color-scheme media query', () => {
      const original = window.matchMedia;
      try {
        window.matchMedia = ((query: string) => ({
          matches: true, // pretend the OS prefers dark
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        })) as typeof window.matchMedia;
        expect(resolveTheme('system')).toBe('dark');
      } finally {
        window.matchMedia = original;
      }
    });
  });

  describe('THEME_MODES', () => {
    it('lists light / dark / system in order, each with an i18n key + icon', () => {
      expect(THEME_MODES.map((m) => m.code)).toEqual([
        'light',
        'dark',
        'system',
      ]);
      THEME_MODES.forEach((m) => {
        expect(m.i18nKey).toMatch(/^preferences\.themeMode\./);
        expect(m.icon).toBeTruthy();
      });
    });
  });

  describe('SUPPORTED_LANGS', () => {
    it('covers the five supported locales with glyph + native name', () => {
      expect(SUPPORTED_LANGS.map((l) => l.code).sort()).toEqual([
        'en',
        'ja',
        'ko',
        'zh-CN',
        'zh-TW',
      ]);
      SUPPORTED_LANGS.forEach((l) => {
        expect(l.glyph.length).toBeGreaterThan(0);
        expect(l.nativeName.length).toBeGreaterThan(0);
      });
    });
  });
});
