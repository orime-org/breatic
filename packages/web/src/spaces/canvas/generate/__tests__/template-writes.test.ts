// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What picking a template in a generate panel writes (inner#977).
 */

import { describe, expect, it } from 'vitest';

import { findTemplate, templatePrompt } from '@breatic/shared';

import { templateWrites } from '@web/spaces/canvas/generate/template-writes';

const grid = findTemplate('storyboard-grid-25');
if (!grid) throw new Error('grid template missing');

describe('templateWrites', () => {
  it('writes the template mode, model and prompt in the reader’s language', () => {
    const out = templateWrites(grid, undefined, 'zh-CN');
    expect(out.mode).toBe('i2i');
    expect(out.model).toBe('nano-banana-pro-edit-ultra');
    expect(out.prompt).toEqual(templatePrompt(grid, 'zh-CN'));
  });

  it('keeps what the node remembers for other models', () => {
    const out = templateWrites(grid, { 'gpt-image-2.5-sunburst-edit': { quality: 'high' } }, 'en');
    expect(out.paramsByModel['gpt-image-2.5-sunburst-edit']).toEqual({ quality: 'high' });
  });

  it('lays the template params over what the node remembers for the template model', () => {
    const out = templateWrites(
      grid,
      { 'nano-banana-pro-edit-ultra': { aspect_ratio: '9:16', style_images: ['x'] } },
      'en',
    );
    expect(out.paramsByModel['nano-banana-pro-edit-ultra']).toEqual({
      aspect_ratio: '1:1',
      resolution: '4k',
      style_images: ['x'],
    });
  });
});
