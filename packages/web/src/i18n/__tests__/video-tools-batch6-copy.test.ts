// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 (canvas design §4 转场、对口型、擦除 rows; demo 2026-10-23-1306-video-tools `messages.json`,
 * `revision-messages.json`, `people-messages.json`): the batch-6 video tool copy ships in all five locales under the
 * namespace the existing video tool copy uses, `canvas.miniTool.videoUI.*`, with the demo's key names, and every
 * translation keeps the placeholders its English message names.
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
];

describe('batch-6 video tool copy in every locale (§97; canvas design §4)', () => {
  it.each(LOCALE_CATALOGS)('%s has every key with its placeholders', (_tag, catalog) => {
    for (const [key, placeholders] of KEYS) {
      const message = readPath(catalog, `canvas.miniTool.videoUI.${key}`);
      expect(typeof message, key).toBe('string');
      for (const name of placeholders) expect(String(message), key).toContain(`{${name}}`);
    }
  });
});
