// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a video run takes material, off the model that declares it (#269).
 *
 * The panel's own registry says what a slot is called and what to draw in it;
 * whether this mode has it, and whether it may stay empty, is per model — one
 * vendor's reference-to-video generates without the motion clip and another
 * may not, and no table keyed by mode alone can say which.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import { describe, it, expect } from 'vitest';

import {
  modelTakesReferences,
  videoSourcePlaces,
} from '@web/spaces/canvas/generate/video-slots';

/**
 * A video model declaring the given params.
 * @param params - What it declares.
 * @returns The catalog entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'a-model',
    display_name: 'A Model',
    modality: 'video',
    mode: ['ref', 'i2v'],
    description: '',
    guide: '',
    tier: 'optional',
    cost_per_call: 1,
    generation_time: 10,
    takes_prompt: true,
    params,
    providers: [],
    sourcesByMode: { ref: ['image'], i2v: ['image'] },
    sourceRuleByMode: { ref: 'all_of', i2v: 'all_of' },
  };
}

const POOL: ParamDescriptor = {
  description: '',
  default: [],
  fill: 'pool',
  accepts: 'image',
  modes: ['ref'],
};

describe('where a video run takes material', () => {
  it('asks for a slot the model does not mark optional', () => {
    const strict = model({
      images: POOL,
      video: { description: '', default: null, fill: 'canvas', accepts: 'video', modes: ['ref'] },
    });

    expect(videoSourcePlaces(strict, 'ref', ['referenceVideo'], {}, ['https://a']))
      .toEqual({ requiredSlots: ['referenceVideo', 'images'], filledSlots: ['images'] });
  });

  it('leaves out a slot the model does mark optional', () => {
    const lenient = model({
      images: POOL,
      video: {
        description: '',
        default: null,
        fill: 'canvas',
        accepts: 'video',
        optional: true,
        modes: ['ref'],
      },
    });

    expect(videoSourcePlaces(lenient, 'ref', ['referenceVideo'], {}, ['https://a']))
      .toEqual({ requiredSlots: ['images'], filledSlots: ['images'] });
  });

  it('leaves out the pool the model marks optional', () => {
    const lenient = model({
      images: { ...POOL, optional: true },
      video: { description: '', default: null, fill: 'canvas', accepts: 'video', modes: ['ref'] },
    });

    expect(videoSourcePlaces(lenient, 'ref', ['referenceVideo'], {}, []))
      .toEqual({ requiredSlots: ['referenceVideo'], filledSlots: [] });
  });

  it('leaves out a slot this mode does not fill', () => {
    const framed = model({
      image: { description: '', default: null, fill: 'canvas', accepts: 'image', modes: ['i2v'] },
    });

    expect(videoSourcePlaces(framed, 'ref', ['firstFrame'], {}, []).requiredSlots).toEqual([]);
    expect(videoSourcePlaces(framed, 'i2v', ['firstFrame'], {}, []).requiredSlots)
      .toEqual(['firstFrame']);
  });

  it('reports a filled slot as filled', () => {
    const framed = model({
      image: { description: '', default: null, fill: 'canvas', accepts: 'image' },
    });

    expect(
      videoSourcePlaces(framed, 'i2v', ['firstFrame'], { firstFrame: 'https://a.png' }, []),
    ).toEqual({ requiredSlots: ['firstFrame'], filledSlots: ['firstFrame'] });
  });

  it('says the pool feeds only the modes the model gives it', () => {
    const pooled = model({ images: POOL });

    expect(modelTakesReferences(pooled, 'ref')).toBe(true);
    expect(modelTakesReferences(pooled, 'i2v')).toBe(false);
    expect(modelTakesReferences(undefined, 'ref')).toBe(false);
  });
});
