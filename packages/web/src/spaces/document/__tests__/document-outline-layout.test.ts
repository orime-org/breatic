// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1149 A17: the outline takes its own column only while the body text
 * beside it keeps at least 304px; narrower, it floats over the body.
 *
 * Tiled, the text gets the Space width less the 240px outline, the body's
 * 72px and 56px gutters and, when it is open, the 288px comment panel.
 */

import { describe, it, expect } from 'vitest';

import { outlineLayout } from '@web/spaces/document/document-outline-layout';

describe('outlineLayout', () => {
  it('tiles while the text keeps 304px with the comment panel shut', () => {
    expect(outlineLayout({ spaceWidth: 672, commentsOpen: false })).toBe('tiled');
    expect(outlineLayout({ spaceWidth: 1440, commentsOpen: false })).toBe('tiled');
  });

  it('floats once the text would get less than 304px with the comment panel shut', () => {
    expect(outlineLayout({ spaceWidth: 671, commentsOpen: false })).toBe('floating');
    expect(outlineLayout({ spaceWidth: 420, commentsOpen: false })).toBe('floating');
  });

  it('counts the open comment panel against the text', () => {
    expect(outlineLayout({ spaceWidth: 960, commentsOpen: true })).toBe('tiled');
    expect(outlineLayout({ spaceWidth: 959, commentsOpen: true })).toBe('floating');
    expect(outlineLayout({ spaceWidth: 959, commentsOpen: false })).toBe('tiled');
  });
});
