// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The sentence a failed web-animation execution is told with (#1490 design §6.5): an export names how the video
 * failed, and every sentence exists in all five locales.
 */

import { describe, expect, it } from 'vitest';

import { failureSentenceKey } from '@web/spaces/web-animation/execution-text';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/**
 * A key's zh-CN text.
 * @param key - The key.
 * @returns The text.
 */
function zh(key: string): string {
  return String(readPath(LOCALE_CATALOGS.find(([tag]) => tag === 'zh-CN')?.[1], key) ?? '');
}

describe('an export failure', () => {
  it.each([
    ['render_failed', '视频渲染失败'],
    ['frame_mismatch', '渲染出的视频与动画长度不一致'],
    ['save_failed', '视频保存失败'],
  ])('tells %s as the design writes it', (reason, sentence) => {
    expect(zh(failureSentenceKey(reason))).toContain(sentence);
  });

  it('has each sentence in all five locales', () => {
    for (const reason of ['render_failed', 'frame_mismatch', 'save_failed']) {
      for (const [tag, catalog] of LOCALE_CATALOGS) expect(String(readPath(catalog, failureSentenceKey(reason)) ?? ''), `${tag} ${reason}`).not.toBe('');
    }
  });
});

describe('a creation failure', () => {
  it('keeps its own sentences', () => {
    expect(failureSentenceKey('harness_failed')).toBe('timeline.webAnimation.failure.stopped');
    expect(failureSentenceKey('validation_failed')).toBe('timeline.webAnimation.failure.check');
    expect(failureSentenceKey(null)).toBe('timeline.webAnimation.failure.unknown');
  });
});
