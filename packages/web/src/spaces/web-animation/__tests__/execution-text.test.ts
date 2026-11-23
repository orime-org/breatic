// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The sentence a failed web-animation execution is told with (#1490 design §6.5): an export names how the video
 * failed, and every sentence exists in all five locales.
 */

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { setLocale } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { endedSentence, endedSentenceKey, failureSentenceKey } from '@web/spaces/web-animation/execution-text';
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
    // The job object restarted and lost the keys its run was submitted with (inner#1953).
    expect(failureSentenceKey('key_lost_on_restart')).toBe('timeline.webAnimation.failure.key_lost');
    expect(failureSentenceKey(null)).toBe('timeline.webAnimation.failure.unknown');
  });
});

describe('an ended run that did not succeed', () => {
  it('tells a failure by its reason and a cancelled or expired run by its status', () => {
    expect(endedSentenceKey('failed', 'save_failed')).toBe(failureSentenceKey('save_failed'));
    expect(endedSentenceKey('cancelled', null)).toBe('timeline.webAnimation.status.cancelled');
    expect(endedSentenceKey('expired', 'internal')).toBe('timeline.webAnimation.status.expired');
  });
});

describe('a failure of the payer\'s own key (inner#1953)', () => {
  /**
   * The English translator.
   * @returns It.
   */
  function english(): ReturnType<typeof useTranslation> {
    setLocale('en');
    return renderHook(() => useTranslation()).result.current;
  }
  const failed = { status: 'failed', failureReason: 'account_key_failed', failureUpstream: 'openrouter', failureKeyReason: 'no_balance' } as const;

  it.each([
    ['self', 'Your OpenRouter key for this run was replaced or deleted. Run it again.'],
    ['admin', 'The Studio Admin\'s OpenRouter key for this run was replaced or deleted. Run it again.'],
  ] as const)('names the upstream and %s as whose key was gone, with the canvas sentence', (payer, sentence) => {
    const row = { status: 'failed', failureReason: 'account_key_missing', failureUpstream: 'openrouter' } as const;
    expect(endedSentence(row, english(), { payer, payerUserId: null, viewerUserId: undefined, upstreamNames: { openrouter: 'OpenRouter' } })).toBe(sentence);
  });

  it.each([
    ['self', 'Your OpenRouter key is out of balance. Top up at OpenRouter.'],
    ['admin', 'The Studio Admin\'s OpenRouter key is out of balance. Ask the Studio Admin to top up at OpenRouter.'],
  ] as const)('tells why the upstream refused %s key', (payer, sentence) => {
    expect(endedSentence(failed, english(), { payer, payerUserId: null, viewerUserId: undefined, upstreamNames: { openrouter: 'OpenRouter' } })).toBe(sentence);
  });

  it('tells a failed key without the key plan by the upstream id', () => {
    const row = { status: 'failed', failureReason: 'account_key_failed', failureUpstream: 'openrouter' } as const;
    expect(endedSentence(row, english(), undefined)).toBe('The openrouter key failed. Check it in BYOK settings.');
  });

  it('names the upstream a run on the payer\'s own key could not reach', () => {
    const row = { status: 'failed', failureReason: 'upstream_unavailable', failureUpstream: 'openrouter' } as const;
    expect(endedSentence(row, english(), undefined)).toBe('Couldn\'t reach openrouter. Try again later.');
  });

  it('tells a cancelled run by its status, whatever reason it holds', () => {
    expect(endedSentence({ ...failed, status: 'cancelled' }, english(), undefined)).toBe('Cancelled');
  });
});
