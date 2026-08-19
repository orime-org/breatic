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

describe('聚焦这个挑选在两个面板上都有回得去的入口（#1978）', () => {
  // Exit 之后键盘焦点回哪，靠这张表按面板查触发器的 testId。视频面板接上
  // 聚焦之后，同一个 purpose 就有了两个面板的入口 —— 表里少一个，视频面板
  // 那次挑选退出时焦点会掉在画布容器上，而这正是 #1902 首帧挑选踩过、这张
  // 表被建出来要终结的那个失败。
  it('focus 同时给得出图片面板和视频面板的触发器', () => {
    expect(PICK_PURPOSE_UI.focus.trigger.generate).toBe('generate-tool-focus');
    expect(PICK_PURPOSE_UI.focus.trigger.generateVideo).toBe(
      'generate-video-tool-focus',
    );
  });

  // 只有 reference 和 focus 是两个面板共有的：style 是图片面板独有，五个帧
  // 槽位是视频面板独有。把这条数出来钉住，防止将来给某个单面板的 purpose
  // 顺手补上另一个面板的入口。
  it('恰好这两个 purpose 是两个面板共有的', () => {
    const both = (Object.keys(PICK_PURPOSE_UI) as PickPurpose[]).filter((p) => {
      const t = PICK_PURPOSE_UI[p].trigger;
      return t.generate !== undefined && t.generateVideo !== undefined;
    });
    expect(both.sort()).toEqual(['focus', 'reference']);
  });
});
