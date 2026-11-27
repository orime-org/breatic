// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

describe('every pick says what IT is asking for (#1918)', () => {
  const purposes = Object.keys(PICK_PURPOSE_UI) as (keyof typeof PICK_PURPOSE_UI)[];

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
  const purposes = Object.keys(PICK_PURPOSE_UI) as (keyof typeof PICK_PURPOSE_UI)[];

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

describe('the focus pick has a trigger in both panels (#1978)', () => {
  // Where keyboard focus goes after Exit is looked up per panel in this table. Once the video panel took focus
  // picks, the same purpose has two panel entries; without one of them, focus lands on the canvas container when
  // the video panel's pick exits, the failure #1902 hit with the first-frame pick and this table exists to end.
  it('focus gives the trigger of both the image and the video panel', () => {
    expect(PICK_PURPOSE_UI.focus.trigger.generate).toBe('generate-tool-focus');
    expect(PICK_PURPOSE_UI.focus.trigger.generateVideo).toBe(
      'generate-video-tool-focus',
    );
  });

  // The audio panel's reference tool starts the same purpose. Without its row, focus lands on body when that pick
  // exits and a keyboard user tabs back from the top of the page: the same failure as the first-frame pick above.
  it('the reference pick has a trigger in all three panels', () => {
    expect(PICK_PURPOSE_UI.reference.trigger.generate).toBe(
      'generate-tool-reference',
    );
    expect(PICK_PURPOSE_UI.reference.trigger.generateVideo).toBe(
      'generate-video-tool-reference',
    );
    expect(PICK_PURPOSE_UI.reference.trigger.generateAudio).toBe(
      'generate-audio-tool-reference',
    );
  });

  // Reference, Focus and Style sit on both the image and the video tool rows
  // (Style since inner#828); the source slots are the video panel's alone.
  // Counted here so a single-panel purpose does not quietly gain the other
  // panel's trigger.
  it('names exactly the purposes the image and video panels share', () => {
    const both = (Object.keys(PICK_PURPOSE_UI) as (keyof typeof PICK_PURPOSE_UI)[]).filter((p) => {
      // Widened first: each row's trigger is narrowed to the panels it names,
      // so reading a key it lacks is a type error.
      const t: Record<string, string> = PICK_PURPOSE_UI[p].trigger;
      return t.generate !== undefined && t.generateVideo !== undefined;
    });
    expect(both.sort()).toEqual(['focus', 'reference', 'style']);
  });
});

