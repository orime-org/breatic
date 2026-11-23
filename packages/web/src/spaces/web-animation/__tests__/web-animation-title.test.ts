// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The one title rule every web-animation row shows by (#1490 design §4.4, §7.1): a create is its request, a
 * modification is "modified from" its base's request with its own instruction, and an export is "video" of its
 * source's title. The execution list, the details, the annotation groups, the Timeline picker, clip names and the
 * conflict list all read it, so a change here reaches all of them at once.
 */

import { describe, expect, it } from 'vitest';

import { webAnimationTitle, type WebAnimationTitleSource } from '@web/spaces/web-animation/web-animation-title';

/**
 * A translator that shows which message was asked for and with what.
 * @param key - The message.
 * @param params - Its values.
 * @returns The key and the values, readable in an assertion.
 * @throws {never} Never.
 */
function t(key: string, params?: Record<string, unknown>): string {
  if (key === 'spaces.webAnimation.titleModifiedFrom') return `MODIFIED[${String(params?.base)}|${String(params?.request)}]`;
  if (key === 'spaces.webAnimation.titleVideo') return `VIDEO[${String(params?.source)}]`;
  return key;
}

const create: WebAnimationTitleSource = { kind: 'web_animation_create', request: 'A logo reveal' };
const modify: WebAnimationTitleSource = { kind: 'web_animation_modify', request: 'Slower', base: { executionId: 'b', request: 'A logo reveal' } };

describe('webAnimationTitle', () => {
  it('titles a create by its whole request', () => {
    expect(webAnimationTitle(create, t)).toBe('A logo reveal');
  });

  it('titles a modification as modified from its base request, with its own instruction', () => {
    expect(webAnimationTitle(modify, t)).toBe('MODIFIED[A logo reveal|Slower]');
  });

  it('titles an export as video of its source create', () => {
    expect(webAnimationTitle({ kind: 'web_animation_export', source: { executionId: 's', request: 'A logo reveal' } }, t)).toBe('VIDEO[A logo reveal]');
  });

  it('titles an export of a modification as video of that modification\'s own title', () => {
    const exported: WebAnimationTitleSource = {
      kind: 'web_animation_export',
      source: { executionId: 'm', request: 'Slower', base: { executionId: 'b', request: 'A logo reveal' } },
    };
    expect(webAnimationTitle(exported, t)).toBe('VIDEO[MODIFIED[A logo reveal|Slower]]');
  });
});
