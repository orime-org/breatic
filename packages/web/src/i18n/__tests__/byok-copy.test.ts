// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The BYOK settings copy (inner#1953): every sentence the dialog and the generation panel show, in all five locales.
 *
 * `i18n-no-missing-keys` reads only the English catalog, so a key missing from another locale shows its user a bare
 * key; this pins all five. "BYOK" and the product noun "Studio" stay as written in every language, and each
 * `{upstream}` placeholder survives translation.
 */

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/** Every BYOK key, with its English sentence; the component tests find elements by these. */
const ENGLISH: Record<string, string> = {
  'byok.heading': 'BYOK settings',
  'byok.tabKeys': 'Upstream keys',
  'byok.tabModels': 'Models',
  'byok.searchUpstreams': 'Search upstreams',
  'byok.added': 'Added',
  'byok.noneAdded': 'None added yet',
  'byok.groupLanguageModel': 'Language model',
  'byok.groupOfficial': 'Official API',
  'byok.groupReseller': 'Reseller',
  'byok.connected': 'Connected',
  'byok.notConnected': 'Not connected',
  'byok.refresh': 'Refresh',
  'byok.replace': 'Replace',
  'byok.delete': 'Delete',
  'byok.save': 'Save',
  'byok.keyLabel': 'API key',
  'byok.getKey': 'Get a key from {upstream}',
  'byok.replaceTitle': 'Replace the {upstream} key',
  'byok.platformKey': 'Platform key (uses credits)',
  'byok.searchModels': 'Search models',
  'byok.goAddKey': 'Add a key',
  'byok.failure.invalid': 'The key is invalid or has been revoked.',
  'byok.disabled': 'Bring your own key is not turned on for this deployment.',
  'canvas.generatePanel.usesOwnKey': 'Uses your key, no credits',
  'canvas.generatePanel.usesStudioKey': 'Uses the Studio\'s key, no credits',
};

/** Sentences whose English wording only needs to carry the point the tests look for. */
const ENGLISH_CARRIES: Record<string, RegExp> = {
  'byok.replaceBody': /tasks using the old key may be interrupted or fail/i,
  'byok.deleteTitle': /\{upstream\}/,
  'byok.deleteBody': /tasks using this key may be interrupted or fail/i,
  'byok.modelsIntro': /platform key/i,
  'byok.modelsEmpty': /^Add an upstream key, then choose here/,
};

const KEYS = [...Object.keys(ENGLISH), ...Object.keys(ENGLISH_CARRIES)];

describe.each(LOCALE_CATALOGS)('%s', (_tag, catalog) => {
  it.each(KEYS)('has %s, not empty', (key) => {
    const message = readPath(catalog, key);
    expect(typeof message).toBe('string');
    expect((message as string).trim()).not.toBe('');
  });

  it.each(KEYS.filter((key) => (ENGLISH[key] ?? '').includes('{upstream}') || key === 'byok.deleteTitle'))(
    'keeps the {upstream} placeholder in %s',
    (key) => {
      expect(readPath(catalog, key) as string).toContain('{upstream}');
    },
  );

  it('keeps BYOK in the heading and Studio untranslated', () => {
    expect(readPath(catalog, 'byok.heading') as string).toContain('BYOK');
    expect(readPath(catalog, 'canvas.generatePanel.usesStudioKey') as string).toContain('Studio');
  });
});

describe('the English sentences', () => {
  const [, en] = LOCALE_CATALOGS[0];

  it.each(Object.entries(ENGLISH))('%s reads "%s"', (key, sentence) => {
    expect(readPath(en, key)).toBe(sentence);
  });

  it.each(Object.entries(ENGLISH_CARRIES))('%s says what it must', (key, pattern) => {
    expect(readPath(en, key) as string).toMatch(pattern);
  });
});
