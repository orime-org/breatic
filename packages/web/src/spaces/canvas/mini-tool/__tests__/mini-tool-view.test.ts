// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { type ModelEntry, type ParamDescriptor } from '@breatic/shared';
import { miniToolById } from '@breatic/shared/mini-tools';

import {
  aspectRatioOf,
  creditMode,
  miniToolRefusal,
  rectForAspect,
  resolvedParams,
  setRectSide,
} from '@web/spaces/canvas/mini-tool/mini-tool-view';

/**
 * A catalog entry declaring the given params.
 * @param params - Its params.
 * @param takesPrompt - Whether a prompt is required.
 * @returns The entry.
 */
function entry(params: Record<string, ParamDescriptor>, takesPrompt = false): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'video',
    mode: ['v2v'],
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 10,
    takes_prompt: takesPrompt,
    params,
    providers: [],
  } as ModelEntry;
}

const tool = (id: string) => {
  const spec = miniToolById(id);
  if (!spec) throw new Error(id);
  return spec;
};

describe('resolvedParams', () => {
  // §13: a model tool opened fresh runs with the catalog's defaults.
  it('starts a model tool on its pinned model defaults, the draft on top', () => {
    const pinned = entry({
      target_resolution: { description: '', default: '1080p', values: ['720p', '1080p'], fill: 'tool' },
    });
    expect(resolvedParams(tool('video.upscale'), pinned, {})).toEqual({ target_resolution: '1080p' });
    expect(resolvedParams(tool('video.upscale'), pinned, { target_resolution: '720p' })).toEqual({
      target_resolution: '720p',
    });
  });

  it('keeps only the keys a tool lists', () => {
    const pinned = entry({ target_resolution: { description: '', default: '1080p', fill: 'tool' } });
    expect(resolvedParams(tool('video.upscale'), pinned, { stray: 1 })).toEqual({ target_resolution: '1080p' });
  });

  it('hands a local tool its draft as is', () => {
    expect(resolvedParams(tool('video.speed'), undefined, { rate: 2 })).toEqual({ rate: 2 });
  });
});

describe('miniToolRefusal', () => {
  const motion = entry({ image: { description: '', default: null, fill: 'tool' } }, true);
  const base = { spec: tool('video.motion'), entry: motion, prompt: 'walk', slots: { character: { url: 'a.png' } } };

  it('lets a filled tool run', () => {
    expect(miniToolRefusal({ ...base, sourceShown: true, exporting: false })).toBeNull();
  });

  it('refuses while the source shows nothing', () => {
    expect(miniToolRefusal({ ...base, sourceShown: false, exporting: false })).toBe('sourceMissing');
  });

  it('refuses an empty required slot', () => {
    expect(miniToolRefusal({ ...base, slots: {}, sourceShown: true, exporting: false })).toBe('slotMissing');
  });

  it('lets an optional slot stay empty', () => {
    const edit = entry({
      reference_images: { description: '', default: null, fill: 'tool', optional: true },
      reference_audios: { description: '', default: null, fill: 'tool', optional: true },
    });
    expect(
      miniToolRefusal({ spec: tool('video.edit'), entry: edit, prompt: 'x', slots: {}, sourceShown: true, exporting: false }),
    ).toBeNull();
  });

  it('refuses an empty prompt the pinned model requires', () => {
    expect(miniToolRefusal({ ...base, prompt: '  ', sourceShown: true, exporting: false })).toBe('promptMissing');
  });

  it('refuses while a browser tool is exporting', () => {
    expect(
      miniToolRefusal({ spec: tool('image.rotate'), entry: undefined, prompt: '', slots: {}, sourceShown: true, exporting: true }),
    ).toBe('exporting');
  });
});

describe('creditMode', () => {
  it('reads the run kind', () => {
    expect(creditMode(tool('image.crop'))).toBe('free');
    expect(creditMode(tool('video.cut'))).toBe('usage');
    expect(creditMode(tool('image.upscale'))).toBe('estimate');
  });
});

describe('crop rectangle', () => {
  const source = { width: 1600, height: 1000 };

  it('reads an aspect choice as a ratio', () => {
    expect(aspectRatioOf('free', source)).toBeNull();
    expect(aspectRatioOf('original', source)).toBe(1.6);
    expect(aspectRatioOf('16:9', source)).toBeCloseTo(16 / 9);
  });

  it('centres the largest rectangle of a ratio', () => {
    expect(rectForAspect(1, source)).toEqual({ x: 300, y: 0, w: 1000, h: 1000 });
  });

  // §13: typing a width with the ratio locked moves the height, and both stay
  // inside the source.
  it('moves the other side with a locked ratio', () => {
    expect(setRectSide({ x: 0, y: 0, w: 800, h: 800 }, 'w', 600, 1, source)).toEqual({ x: 0, y: 0, w: 600, h: 600 });
  });

  it('clamps to the source, keeping the ratio', () => {
    expect(setRectSide({ x: 400, y: 0, w: 800, h: 800 }, 'w', 5000, 1, source)).toEqual({
      x: 400,
      y: 0,
      w: 1000,
      h: 1000,
    });
  });

  it('clamps one side alone when free', () => {
    expect(setRectSide({ x: 100, y: 100, w: 500, h: 500 }, 'h', 2000, null, source)).toEqual({
      x: 100,
      y: 100,
      w: 500,
      h: 900,
    });
  });

  it('never goes under one pixel', () => {
    expect(setRectSide({ x: 0, y: 0, w: 500, h: 500 }, 'w', 0, null, source).w).toBe(1);
  });
});
