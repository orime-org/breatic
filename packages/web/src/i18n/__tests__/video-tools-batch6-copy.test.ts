// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

describe('batch-6 video tool copy in every locale (§97; canvas design §4)', () => {
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
});
