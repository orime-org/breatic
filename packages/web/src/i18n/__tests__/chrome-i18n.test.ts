// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/** The catalogs this suite asserts about one at a time. */
const BY_TAG = new Map(LOCALE_CATALOGS);

// Project-chrome i18n (#1339): every icon-button / menu aria-label must
// resolve through i18n instead of being hardcoded English, so a non-English
// screen-reader user is announced the UI in their own language. Frozen product
// nouns (Studio / Space) stay English inside the translated phrase
// ("返回 Studio").

/** Every new chrome i18n key paired with its English value (existence + en). */
const NEW_KEYS_EN: ReadonlyArray<readonly [string, string]> = [
  ['chrome.aria.backToStudio', 'Back to Studio'],
  ['chrome.aria.creditsBalance', 'Credits balance'],
  ['chrome.aria.home', 'Home'],
  ['chrome.aria.scrollTabsLeft', 'Scroll tabs left'],
  ['chrome.aria.scrollTabsRight', 'Scroll tabs right'],
  ['chrome.aria.spacesToolbar', 'Spaces'],
  ['chrome.aria.openSpaces', 'Open spaces'],
  ['chrome.aria.language', 'Language: {name}'],
  ['chrome.aria.theme', 'Theme: {theme}'],
  ['spaces.lockedAria', 'Locked'],
  ['spaces.tab.closeAria', 'Close space tab'],
  ['members.stack.triggerAria', 'Project members ({count})'],
];

/** Action keys that MUST be translated (zh-CN value differs from English). */
const TRANSLATED_ZH_CN: ReadonlyArray<readonly [string, string]> = [
  ['chrome.aria.home', '首页'],
  ['spaces.lockedAria', '已锁定'],
];

/** Chrome source files whose aria-labels were de-hardcoded by #1339. */
const SCANNED_FILES: readonly string[] = [
  'src/pages/project/chrome/top-bar/TopBar.tsx',
  'src/pages/project/chrome/top-bar/ShareDialog.tsx',
  'src/pages/project/chrome/top-bar/Logo28.tsx',
  'src/pages/project/chrome/top-bar/MembersStack.tsx',
  'src/pages/project/chrome/agent-header/AgentColHeader.tsx',
  'src/pages/project/chrome/tab-bar/SpaceTabBar.tsx',
  'src/pages/project/chrome/tab-bar/SpaceTab.tsx',
  'src/pages/project/chrome/tab-bar/SpaceDrawer.tsx',
  'src/features/notifications/BellMenu.tsx',
  'src/features/preferences/LangSwitcher.tsx',
  'src/features/preferences/ThemeToggle.tsx',
];

/** English phrases that lived inside ternary aria-labels (now routed via t()). */
const TERNARY_PHRASES: readonly string[] = [
  'Scroll tabs left',
  'Scroll tabs right',
  'Hide agent column',
  'Show agent column',
];

describe('project-chrome i18n (#1339)', () => {
  describe('new keys exist in every locale', () => {
    for (const [locale, catalog] of LOCALE_CATALOGS) {
      for (const [key] of NEW_KEYS_EN) {
        it(`${locale}: ${key} present`, () => {
          const v = readPath(catalog, key);
          expect(typeof v).toBe('string');
          expect((v as string).length).toBeGreaterThan(0);
        });
      }
    }
  });

  describe('English values are the original strings', () => {
    for (const [key, value] of NEW_KEYS_EN) {
      it(`en: ${key} → "${value}"`, () => {
        expect(readPath(BY_TAG.get('en'), key)).toBe(value);
      });
    }
  });

  describe('action labels are actually translated (zh-CN ≠ English)', () => {
    for (const [key, zh] of TRANSLATED_ZH_CN) {
      it(`zh-CN: ${key} → "${zh}"`, () => {
        expect(readPath(BY_TAG.get('zh-CN'), key)).toBe(zh);
      });
    }
  });

  it('frozen noun aria stays English in every locale (Spaces)', () => {
    for (const [, catalog] of LOCALE_CATALOGS) {
      expect(readPath(catalog, 'chrome.aria.spacesToolbar')).toBe('Spaces');
    }
  });

  describe('no hardcoded English aria-labels remain in chrome source', () => {
    for (const rel of SCANNED_FILES) {
      it(`${rel} routes every aria-label through i18n`, () => {
        const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
        // String-literal and template-literal aria-labels are hardcoded.
        expect(src).not.toMatch(/aria-label='/);
        expect(src).not.toMatch(/aria-label="/);
        expect(src).not.toMatch(/aria-label=\{`/);
        // Ternary aria-labels that embedded English phrases.
        for (const phrase of TERNARY_PHRASES) {
          expect(src).not.toContain(phrase);
        }
      });
    }
  });
});
