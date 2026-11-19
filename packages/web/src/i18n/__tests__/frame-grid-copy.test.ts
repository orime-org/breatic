// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §69 U08 (frames-split design §10.12 `locales/*.json` rows, §7.9 last paragraph, §7.12): the copy
 * only the frame table used goes away in all five locales, and the presentation states ship in all five with the text the
 * user approved in the presentation-states demo (inner#1306, demo 2026-11-05 `new-copy.json`): "Preparing video…" while a
 * video is prepared (panel, node, Document block, Timeline, hover preview), the temporary failure line and the too-long
 * reason.
 */

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/** Keys only the frame table used: the table read wait and the failed table read. */
const FRAME_TABLE_KEYS = ['loadingFrames', 'framesFailed'] as const;

/** The approved presentation-state copy, per locale. */
const APPROVED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  preparingVideo: { en: 'Preparing video…', 'zh-CN': '正在准备视频…', 'zh-TW': '正在準備影片…', ja: '動画を準備中…', ko: '동영상 준비 중…' },
  preparationFailed: { en: 'Couldn\'t prepare the video', 'zh-CN': '视频准备失败', 'zh-TW': '影片準備失敗', ja: '動画を準備できませんでした', ko: '동영상을 준비하지 못했습니다' },
  tooLongToPrepare: { en: 'Too long to prepare', 'zh-CN': '超出可准备时长', 'zh-TW': '超出可準備時長', ja: '準備できる長さを超えています', ko: '준비할 수 있는 길이를 초과했습니다' },
};

describe('U08 frame-grid copy in every locale (§10.12)', () => {
  it.each(LOCALE_CATALOGS)('U08: %s has no copy left that only the frame table used', (_tag, catalog) => {
    for (const key of FRAME_TABLE_KEYS) expect(readPath(catalog, `canvas.miniTool.videoUI.${key}`), key).toBeUndefined();
  });

  it.each(LOCALE_CATALOGS)('U08: %s carries the approved presentation-state copy', (tag, catalog) => {
    for (const [key, texts] of Object.entries(APPROVED)) expect(readPath(catalog, `canvas.miniTool.videoUI.${key}`), key).toBe(texts[tag]);
  });
});
