// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The template registry: what each generate panel lists and what a template
 * writes (inner#977).
 */

import { describe, expect, it } from 'vitest';

import {
  GENERATION_TEMPLATES,
  TEMPLATE_LOCALES,
  findTemplate,
  templatePrompt,
  templatesFor,
} from '@shared/canvas/generation-templates.js';

describe('generation templates', () => {
  it('lists the two image templates and nothing for video or audio yet', () => {
    expect(templatesFor('image').map((t) => t.id)).toEqual(['storyboard-grid-25', 'costume-sheet']);
    expect(templatesFor('video')).toEqual([]);
    expect(templatesFor('audio')).toEqual([]);
  });

  it('fixes the mode, model and the params the real runs settled on', () => {
    expect(findTemplate('storyboard-grid-25')).toMatchObject({
      nodeType: 'image',
      mode: 'i2i',
      model: 'nano-banana-pro-edit-ultra',
      params: { aspect_ratio: '1:1', resolution: '4k' },
    });
    expect(findTemplate('costume-sheet')).toMatchObject({
      nodeType: 'image',
      mode: 'i2i',
      model: 'nano-banana-pro-edit-ultra',
      params: { aspect_ratio: '16:9', resolution: '4k' },
    });
  });

  it('answers undefined for an id it does not have', () => {
    expect(findTemplate('no-such-template')).toBeUndefined();
  });

  it('carries a prompt in every interface language, each with one reference mark first and one rewrite mark', () => {
    for (const template of GENERATION_TEMPLATES) {
      for (const locale of TEMPLATE_LOCALES) {
        const segments = templatePrompt(template, locale);
        const slots = segments.flatMap((s) => (s.slot ? [s.slot.kind] : []));
        expect(slots, `${template.id} ${locale}`).toEqual(['asset', 'tweak']);
        expect(segments.find((s) => s.slot)?.slot?.kind, `${template.id} ${locale}`).toBe('asset');
      }
    }
  });

  it('writes the prompt in the reader’s language and falls back to English', () => {
    const grid = findTemplate('storyboard-grid-25');
    if (!grid) throw new Error('grid template missing');
    const text = (locale: string): string =>
      templatePrompt(grid, locale)
        .map((s) => s.text ?? '')
        .join('');
    expect(text('zh-CN')).toContain('5 行 5 列');
    expect(text('en')).toContain('5 rows and 5 columns');
    expect(text('fr')).toBe(text('en'));
  });
});
