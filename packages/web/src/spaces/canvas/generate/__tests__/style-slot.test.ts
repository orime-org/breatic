// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import { IMAGE_SLOTS } from '@web/spaces/canvas/generate/image-slots';
import { allSlotSpecs, slotForPurpose } from '@web/spaces/canvas/generate/slots';
import { STYLE_SLOT, styleCapFor } from '@web/spaces/canvas/generate/style-slot';

/**
 * A model with the given style declaration, in the given modes.
 * @param style - The `style_images` declaration, or undefined for none.
 * @param modes - The modes the declaration applies to, when narrowed.
 * @returns A minimal model entry.
 */
function model(style: { max_items: number } | undefined, modes?: string[]): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'video',
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 60,
    takes_prompt: true,
    mode: 'ref',
    providers: [],
    params:
      style === undefined
        ? {}
        : {
          style_images: {
            description: '',
            default: null,
            type: 'list',
            fill: 'canvas',
            accepts: 'image',
            optional: true,
            ...style,
            ...(modes ? { modes } : {}),
          },
        },
  } as ModelEntry;
}

describe('the shared style slot', () => {
  it('is the one entry the image registry holds', () => {
    expect(IMAGE_SLOTS.style).toBe(STYLE_SLOT);
    expect(allSlotSpecs().filter((spec) => spec.purpose === 'style')).toEqual([STYLE_SLOT]);
    expect(slotForPurpose('style')).toBe('style');
  });

  it('gives the cap of a model that fills style images off the canvas', () => {
    expect(styleCapFor(model({ max_items: 3 }), 'ref')).toBe(3);
  });

  it('gives no cap for a model without the declaration, or outside its modes', () => {
    expect(styleCapFor(model(undefined), 'ref')).toBeUndefined();
    expect(styleCapFor(model({ max_items: 3 }, ['t2v']), 'ref')).toBeUndefined();
    expect(styleCapFor(undefined, 'ref')).toBeUndefined();
  });
});
