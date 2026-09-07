// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many reference images the model in front of the user takes right now
 * (#1928).
 *
 * Two readers ask it. The panel refuses a submit carrying more than this, and
 * the canvas refuses to ADD one past it — a connection, a pick click, a focus
 * crop. The canvas asked a narrower question until now (its own site-wide
 * sanity knob, which knows nothing about models), so a cap that moves with
 * another param would have let a user connect a fifth image and only hear
 * about it at submit.
 */

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import { modelReferenceCap } from '@web/spaces/canvas/generate/model-reference-cap';

/** A catalog entry declaring `images` the way `kling-o3-pro-ref` does. */
function refModel(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'kling-o3-pro-ref',
    display_name: 'Kling O3 Pro Ref',
    modality: 'video',
    mode: 'ref',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 56,
    generation_time: 120,
    takes_prompt: true,
    providers: [],
    params: {
      images: {
        description: 'Reference image URLs',
        type: 'list',
        max_items: 7,
        max_items_when_present: { video: 4 },
        default: null,
      },
      video: { description: 'Reference video URL', default: null },
    },
    ...over,
  } as ModelEntry;
}

describe('the reference-image cap the model is holding right now', () => {
  it('is the plain cap while the reference-video slot is empty', () => {
    expect(modelReferenceCap(refModel(), 'ref', {})).toBe(7);
  });

  it('drops once that slot is filled', () => {
    expect(
      modelReferenceCap(refModel(), 'ref', {
        referenceVideo: 'https://cdn/clip.mp4',
      }),
    ).toBe(4);
  });

  it('reads the slot through the mode, so a stale pick from another mode is ignored', () => {
    // A slot's value stays on the node across a mode switch by design. Under a
    // mode that does not collect it, the vendor never sees the clip, so the
    // cap it would have lowered does not apply either.
    expect(
      modelReferenceCap(refModel(), 't2v', {
        referenceVideo: 'https://cdn/clip.mp4',
      }),
    ).toBe(7);
  });

  it('is undefined when the model declares no image list', () => {
    const noImages = refModel({ params: { seed: { description: '', default: -1 } } });
    expect(modelReferenceCap(noImages, 'ref', {})).toBeUndefined();
  });

  it('is undefined when the catalog has not answered yet', () => {
    // The canvas asks before the panel is open, so this is the ordinary case
    // on a fresh space, not an edge: the caller falls back to the site-wide
    // knob rather than inventing a number.
    expect(modelReferenceCap(undefined, 'ref', {})).toBeUndefined();
  });

  it('treats a zero or absent max_items as uncapped', () => {
    const uncapped = refModel({
      params: { images: { description: '', type: 'list', default: null } },
    });
    expect(modelReferenceCap(uncapped, 'ref', {})).toBeUndefined();
  });
});
