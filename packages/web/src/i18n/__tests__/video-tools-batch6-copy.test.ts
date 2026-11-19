// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (canvas design §4 转场、对口型、擦除 rows; demo 2026-10-23-1306-video-tools `messages.json`,
 * `revision-messages.json`, `people-messages.json`): the batch-6 video tool copy ships in all five locales under the
 * namespace the existing video tool copy uses, `canvas.miniTool.videoUI.*`, with the demo's key names, and every
 * translation keeps the placeholders its English message names. The lip-sync range toasts (`lipSyncDurationRange`,
 * `lipSyncTrackingRange`) carry the coordinator's English text (D18), and the transition type label
 * `canvas.miniTool.videoUI.transition` reads the demo's `transition` label in each locale (`messages.json`).
 */

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/** Each new key and the ICU placeholders its message takes. */
const KEYS: readonly (readonly [string, readonly string[]])[] = [
  ['transitionTooShort', []],
  ['timelineClipTooShort', []],
  ['transitionCut', []],
  ['transitionFade', []],
  ['transitionWipeLeft', []],
  ['transitionWipeRight', []],
  ['personFailNoFace', []],
  ['personFailRejected', []],
  ['personFailTimeout', []],
  ['personFailFailed', []],
  ['personFailStopped', []],
  ['personFailNoFaceNext', []],
  ['personFailRejectedNext', []],
  ['personFailRetryNext', []],
  ['personFailStoppedNext', ['number']],
  ['personFailFollowNext', ['number']],
  ['retryFailedPeople', []],
  ['sharedFailPreparation', []],
  ['sharedFailCompositing', []],
  ['sharedFailStitching', []],
  ['sharedFailExpired', []],
  ['trackingEstimate', ['credits']],
  ['trackingActual', ['credits']],
  ['lipSyncDurationRange', ['min', 'max', 'duration']],
  ['lipSyncTrackingRange', ['min', 'max', 'length']],
];

/** The English text fixed for the new range toasts. */
const ENGLISH: Readonly<Record<string, string>> = {
  lipSyncDurationRange: 'This model takes {min}–{max} s; the result is {duration} s.',
  lipSyncTrackingRange: 'Person tracking takes {min}–{max} s of video; this run uses {length} s.',
};

/** The demo's transition type label in each locale (the demo's `messages.json`, key `transition`). */
const TRANSITION_LABEL: Readonly<Record<string, string>> = { en: 'Type', 'zh-CN': '转场类型', 'zh-TW': '轉場類型', ja: '種類', ko: '유형' };

/** The zh-CN transitions timeline instructions the user approved: two clips, ends trimmed, the swap button orders them, one transition. */
const ZH_CN_TIMELINE_INSTRUCTIONS = '拖动片段两端调整入出点，用交换按钮调换两段顺序，设置两段之间的转场，播放预览后导出。';

/** How each catalog names a button inside a sentence: bare in English, in corner brackets in zh-TW, ja and ko. */
const BUTTON_IN_SENTENCE: Readonly<Record<string, (label: string) => string>> = {
  en: (label) => label,
  'zh-TW': (label) => `「${label}」`,
  ja: (label) => `「${label}」`,
  ko: (label) => `「${label}」`,
};

/** The word each locale's lip-sync panel uses for detecting people (its `redetectPeople` button and the anchor refusal). */
const DETECT_WORD: Readonly<Record<string, string>> = { en: 'detect', 'zh-CN': '识别', 'zh-TW': '辨識', ja: '検出', ko: '감지' };

describe('batch-6 video tool copy in every locale (§97; canvas design §4)', () => {
  it.each(LOCALE_CATALOGS)('%s lip-sync people lines name the detect action its button carries', (tag, catalog) => {
    const word = DETECT_WORD[tag]!;
    expect(String(readPath(catalog, 'canvas.miniTool.videoUI.redetectPeople')).toLowerCase(), 'redetectPeople').toContain(word);
    for (const key of ['peopleIdle', 'identifyingPeople', 'peopleIdentificationFailed']) {
      expect(String(readPath(catalog, `canvas.miniTool.videoUI.${key}`)).toLowerCase(), key).toContain(word);
    }
  });

  it.each(LOCALE_CATALOGS)('%s people detection failure line names the re-detect button, the only action in that state', (_tag, catalog) => {
    const label = String(readPath(catalog, 'canvas.miniTool.videoUI.redetectPeople'));
    expect(String(readPath(catalog, 'canvas.miniTool.videoUI.peopleIdentificationFailed'))).toContain(label);
  });

  it.each(LOCALE_CATALOGS)('%s has every key with its placeholders', (_tag, catalog) => {
    for (const [key, placeholders] of KEYS) {
      const message = readPath(catalog, `canvas.miniTool.videoUI.${key}`);
      expect(typeof message, key).toBe('string');
      for (const name of placeholders) expect(String(message), key).toContain(`{${name}}`);
    }
  });

  it('en carries the fixed text of the lip-sync range toasts', () => {
    const [, en] = LOCALE_CATALOGS[0];
    for (const [key, text] of Object.entries(ENGLISH)) expect(readPath(en, `canvas.miniTool.videoUI.${key}`), key).toBe(text);
  });

  it.each(LOCALE_CATALOGS)('%s labels the transition type as the demo does', (tag, catalog) => {
    expect(readPath(catalog, 'canvas.miniTool.videoUI.transition')).toBe(TRANSITION_LABEL[tag]);
  });

  it('zh-CN timeline instructions describe the two-clip timeline the user approved', () => {
    const [, zhCN] = LOCALE_CATALOGS[1];
    expect(readPath(zhCN, 'canvas.miniTool.videoUI.timelineInstructions')).toBe(ZH_CN_TIMELINE_INSTRUCTIONS);
  });

  it.each(LOCALE_CATALOGS.filter(([tag]) => tag !== 'zh-CN'))('%s timeline instructions name the swap button by its own label', (tag, catalog) => {
    const label = String(readPath(catalog, 'canvas.miniTool.videoUI.swapClips'));
    expect(String(readPath(catalog, 'canvas.miniTool.videoUI.timelineInstructions'))).toContain(BUTTON_IN_SENTENCE[tag]!(label));
  });
});
