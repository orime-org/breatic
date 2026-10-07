// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What picking a template in a generate panel writes (inner#977).
 */

import { describe, expect, it } from 'vitest';

import { findTemplate, setLocale, templatePrompt, type ModelEntry } from '@breatic/shared';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { templateFeeders, templateWrites } from '@web/spaces/canvas/generate/template-writes';

const grid = findTemplate('storyboard-grid-25');
if (!grid) throw new Error('grid template missing');

/** The template's model, declaring one param the template leaves alone. */
const ULTRA: ModelEntry = {
  name: 'nano-banana-pro-edit-ultra',
  display_name: 'Nano Banana Pro Ultra',
  modality: 'image',
  mode: 'i2i',
  description: '',
  guide: '',
  tier: 'recommended',
  generation_time: 10,
  takes_prompt: true,
  providers: [],
  params: {
    aspect_ratio: { description: '', values: ['1:1', '16:9', '9:16'], default: '16:9' },
    resolution: { description: '', values: ['1k', '4k'], default: '1k' },
    output_format: { description: '', values: ['png', 'jpeg'], default: 'png' },
  },
};

describe('templateWrites', () => {
  it('writes the template mode, model and prompt in the reader’s language', () => {
    setLocale('zh-CN');
    const out = templateWrites(grid, undefined, ULTRA);
    setLocale('en');
    expect(out.mode).toBe('i2i');
    expect(out.model).toBe('nano-banana-pro-edit-ultra');
    expect(out.prompt.map((s) => s.text ?? '').join('')).toContain('5 行 5 列');
  });

  it('keeps what the node remembers for other models', () => {
    const out = templateWrites(grid, { paramsByModel: { 'gpt-image-2.5-sunburst-edit': { quality: 'high' } } }, ULTRA);
    expect(out.paramsByModel['gpt-image-2.5-sunburst-edit']).toEqual({ quality: 'high' });
  });

  it('lays the template params over the template model’s record, resolved the way a model switch resolves it', () => {
    const out = templateWrites(
      grid,
      { paramsByModel: { 'nano-banana-pro-edit-ultra': { aspect_ratio: '9:16', output_format: 'jpeg', retired: 1 } } },
      ULTRA,
    );
    // Its own pick stays, the template's two win, an undeclared key goes.
    expect(out.paramsByModel['nano-banana-pro-edit-ultra']).toEqual({
      aspect_ratio: '1:1',
      resolution: '4k',
      output_format: 'jpeg',
    });
  });

  it('fills the declared defaults on a model the node has never used', () => {
    const out = templateWrites(grid, undefined, ULTRA);
    expect(out.paramsByModel['nano-banana-pro-edit-ultra']).toEqual({
      aspect_ratio: '1:1',
      resolution: '4k',
      output_format: 'png',
    });
    expect(out.prompt).toEqual(templatePrompt(grid));
  });
});

/**
 * A reference rail row.
 * @param id - The source node id.
 * @param type - The source node type.
 * @param focus - Whether it is a focus crop row.
 * @returns The row.
 */
function row(id: string, type: ReferenceRailItem['sourceNodeType'], focus?: true): ReferenceRailItem {
  return { refId: `e-${id}`, sourceNodeId: id, sourceNodeType: type, sourceNodeName: id, ...(focus ? { focus } : {}) };
}

describe('templateFeeders', () => {
  it('hands the wired-in images to the asset marks in rail order', () => {
    const feeders = templateFeeders([row('a', 'image'), row('t', 'text'), row('b', 'image')]);
    expect(feeders).toEqual({
      sources: [
        { id: 'a', kind: 'image' },
        { id: 'b', kind: 'image' },
      ],
      upstream: [],
    });
  });

  it('leaves focus crops and repeated nodes out', () => {
    const feeders = templateFeeders([row('a', 'image'), row('a', 'image'), row('focus:x', 'image', true)]);
    expect(feeders.sources).toEqual([{ id: 'a', kind: 'image' }]);
  });
});
