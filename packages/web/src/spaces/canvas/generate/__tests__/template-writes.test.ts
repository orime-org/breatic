// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What picking a template in a generate panel writes to each of its generate
 * nodes (inner#977, inner#1345 6.4): the anchor and every reused upstream
 * generation. The prompts come from `expandTemplate`, not from here.
 */

import { describe, expect, it } from 'vitest';

import type { ModelEntry, TemplateGenerateNode } from '@breatic/shared';

import { templateParams } from '@web/spaces/canvas/generate/template-writes';

/** The storyboard's anchor node, as the migrated template declares it. */
const grid: TemplateGenerateNode = {
  key: 'grid',
  role: 'generate',
  type: 'image',
  mode: 'i2i',
  model: 'nano-banana-pro-edit-ultra',
  params: { aspect_ratio: '1:1', resolution: '4k' },
};

/** An upstream generation of a multi-node template, on another model. */
const upstream: TemplateGenerateNode = {
  key: 'sheet',
  role: 'generate',
  type: 'image',
  mode: 't2i',
  model: 'sheet-model',
  params: { aspect_ratio: '16:9' },
};

/** The upstream node's model. */
const SHEET: ModelEntry = {
  name: 'sheet-model',
  display_name: 'Sheet',
  modality: 'image',
  mode: 't2i',
  description: '',
  guide: '',
  tier: 'recommended',
  generation_time: 10,
  takes_prompt: true,
  providers: [],
  params: { aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '1:1' } },
};

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

describe('templateParams', () => {
  it('gives a non-anchor generation its own model’s params, keeping its other records', () => {
    const out = templateParams(upstream, { paramsByModel: { 'nano-banana': { aspect_ratio: '4:3' } } }, SHEET);
    expect(out).toEqual({
      'nano-banana': { aspect_ratio: '4:3' },
      'sheet-model': { aspect_ratio: '16:9' },
    });
  });

  it('keeps what the node remembers for other models', () => {
    const out = templateParams(grid, { paramsByModel: { 'gpt-image-2.5-sunburst-edit': { quality: 'high' } } }, ULTRA);
    expect(out['gpt-image-2.5-sunburst-edit']).toEqual({ quality: 'high' });
  });

  it('lays the template params over the template model’s record, resolved the way a model switch resolves it', () => {
    const out = templateParams(
      grid,
      { paramsByModel: { 'nano-banana-pro-edit-ultra': { aspect_ratio: '9:16', output_format: 'jpeg', retired: 1 } } },
      ULTRA,
    );
    // Its own pick stays, the template's two win, an undeclared key goes.
    expect(out['nano-banana-pro-edit-ultra']).toEqual({
      aspect_ratio: '1:1',
      resolution: '4k',
      output_format: 'jpeg',
    });
  });

  it('fills the declared defaults on a model the node has never used', () => {
    const out = templateParams(grid, undefined, ULTRA);
    expect(out['nano-banana-pro-edit-ultra']).toEqual({
      aspect_ratio: '1:1',
      resolution: '4k',
      output_format: 'png',
    });
  });
});
