// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A18: every line of text the block handle and the insert menu
 * put on screen exists in all five catalogs and is really translated.
 *
 * The repo's `i18n-no-missing-keys` guard reads `locales/en.json` as the
 * catalogue and never opens the other four, so a key present in English alone
 * passes it while four languages render the bare key.
 */

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/** The lines this slice added. */
const KEYS = [
  // The two tooltips on the strip. The handle's says both gestures, and it is
  // the only place a reader is told the handle can be dragged.
  'spaces.document.blockHandle.dragTip',
  'spaces.document.blockHandle.addTip',
  // The three block handle menu rows that are not already named by the block
  // type menu or the bubble bar.
  'spaces.document.blockHandle.duplicate',
  'spaces.document.blockHandle.insertBelow',
  'spaces.document.blockHandle.delete',
  // The insert menu's group heading, and what it says when a query matches
  // nothing.
  'spaces.document.insertMenu.basicGroup',
  'spaces.document.insertMenu.empty',
] as const;

describe.each(KEYS)('%s', (key) => {
  it.each(LOCALE_CATALOGS)('is a non-empty string in %s', (_tag, catalog) => {
    const message = readPath(catalog, key);
    expect(typeof message).toBe('string');
    expect((message as string).trim()).not.toBe('');
  });

  it('is translated in the four non-English catalogs', () => {
    // Copying the English across also passes the case above, and the reader
    // gets a foreign sentence.
    const english = readPath(LOCALE_CATALOGS[0][1], key);
    for (const [tag, catalog] of LOCALE_CATALOGS.slice(1)) {
      expect(readPath(catalog, key), tag).not.toBe(english);
    }
  });
});
