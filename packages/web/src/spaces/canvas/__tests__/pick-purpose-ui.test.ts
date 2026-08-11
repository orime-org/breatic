// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every banner the pick table names is a message the catalogs answer.
 *
 * `satisfies Record<PickPurpose, …>` already makes a MISSING row a compile
 * error — that is what the table was built for. It says nothing about whether
 * the key in a row that IS there resolves: the key is table data, and
 * `i18n-no-missing-keys` only reads keys spelled out inside a `t(...)` call.
 * So the failure the table was meant to end — a pick that puts the wrong
 * sentence on screen — can still happen one step further along, with the
 * banner reading `canvas.generatePanel.selectEndFrmaeFromCanvas`.
 *
 * The end-frame row (#1904) is what prompted this; the rest are covered too
 * because carving out rows of one table would be the same hand-kept list this
 * table exists to replace.
 */

import { describe, it, expect } from 'vitest';

import { PICK_PURPOSE_UI } from '@web/spaces/canvas/pick-purpose-ui';
import type { PickPurpose } from '@web/stores/canvas';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

describe('every pick says what IT is asking for (#1918)', () => {
  const purposes = Object.keys(PICK_PURPOSE_UI) as PickPurpose[];

  it('gives every purpose its own banner, never a borrowed one', () => {
    // Resolving in all five catalogs (below) only proves a key exists. It
    // says nothing about the key being the RIGHT one: point the character
    // image at `selectFirstFrameFromCanvas` — a real key, translated
    // everywhere — and the suite below stays green while the user picking a
    // character reads "select the first frame". That is the exact shape of
    // the bug #1902 shipped, where a first-frame pick said "select a
    // reference".
    const banners = purposes.map((p) => PICK_PURPOSE_UI[p].banner);
    expect(new Set(banners).size).toBe(banners.length);
  });
});

describe('the pick table names only banners the catalogs answer', () => {
  const purposes = Object.keys(PICK_PURPOSE_UI) as PickPurpose[];

  it.each(purposes)('%s resolves in every locale', (purpose) => {
    const key = PICK_PURPOSE_UI[purpose].banner;
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      expect(
        typeof readPath(catalog, key),
        `${tag} has no message at ${key}`,
      ).toBe('string');
    }
  });
});
