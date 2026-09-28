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
  videoMissing,
  videoSlotsForModel,
} from '@web/spaces/canvas/generate/video-slots';

/**
 * A video model declaring the given params.
 * @param params - What it declares.
 * @param sourceGroups - Its "any one of these" groups, if any.
 * @returns The catalog entry.
 */
function model(
  params: Record<string, ParamDescriptor>,
  sourceGroups?: ModelEntry['source_groups'],
): ModelEntry {
  return {
    name: 'a-model',
    display_name: 'A Model',
    modality: 'video',
    mode: ['ref', 'i2v', 'first_last'],
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 10,
    takes_prompt: true,
    params,
    providers: [],
    ...(sourceGroups ? { source_groups: sourceGroups } : {}),
  };
}

const POOL: ParamDescriptor = {
  description: '',
  default: [],
  type: 'list',
  fill: 'pool',
  accepts: 'image',
  modes: ['ref'],
};

describe('what a video run still needs', () => {
  it('asks for a slot the model does not mark optional', () => {
    const strict = model({
      images: POOL,
      video: { description: '', default: null, fill: 'canvas', accepts: 'video', modes: ['ref'] },
    });

    expect(videoMissing(strict, 'ref', ['referenceVideo'], {}, ['https://a'])).toEqual([['video']]);
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

    expect(videoMissing(lenient, 'ref', ['referenceVideo'], {}, [])).toEqual([['images']]);
  });

  it('leaves out a slot this mode does not fill', () => {
    const framed = model({
      image: { description: '', default: null, fill: 'canvas', accepts: 'image', modes: ['i2v'] },
    });

    expect(videoMissing(framed, 'ref', ['firstFrame'], {}, [])).toEqual([]);
    expect(videoMissing(framed, 'i2v', ['firstFrame'], {}, [])).toEqual([['image']]);
  });

  it('counts a filled slot as filled', () => {
    const framed = model({
      image: { description: '', default: null, fill: 'canvas', accepts: 'image' },
    });

    expect(videoMissing(framed, 'i2v', ['firstFrame'], { firstFrame: 'https://a.png' }, []))
      .toEqual([]);
  });

  it('names the empty places in the order the toolbar offers them', () => {
    // A model may declare its last frame before its first; the reader is told
    // about the first place on the toolbar that is still empty.
    const frames = model({
      end_image: { description: '', default: null, fill: 'canvas', accepts: 'image' },
      image: { description: '', default: null, fill: 'canvas', accepts: 'image' },
    });

    expect(videoMissing(frames, 'first_last', ['firstFrame', 'endFrame'], {}, []))
      .toEqual([['image'], ['end_image']]);
  });

  it('asks for any one of a group the model declares for the mode', () => {
    const grouped = model(
      { images: { ...POOL, optional: true } },
      [{ mode: 'ref', any_of: ['images', 'videos'] }],
    );

    expect(videoMissing(grouped, 'ref', [], {}, [])).toEqual([['images', 'videos']]);
    expect(videoMissing(grouped, 'ref', [], {}, ['https://a'])).toEqual([]);
  });

  it('needs nothing when no model resolves', () => {
    expect(videoMissing(undefined, 'ref', ['referenceVideo'], {}, [])).toEqual([]);
  });

  it('says the pool feeds only the modes the model gives it', () => {
    const pooled = model({ images: POOL });

    expect(modelTakesReferences(pooled, 'ref')).toBe(true);
    expect(modelTakesReferences(pooled, 'i2v')).toBe(false);
    expect(modelTakesReferences(undefined, 'ref')).toBe(false);
  });
});

describe('which slots the video toolbar draws', () => {
  const PICTURE: ParamDescriptor = { description: '', default: null, fill: 'canvas', accepts: 'image' };
  const CLIP: ParamDescriptor = { description: '', default: null, fill: 'canvas', accepts: 'video' };
  const TRACK: ParamDescriptor = { description: '', default: null, fill: 'canvas', accepts: 'audio' };

  it('draws the talking-head slots the model declares, and no others', () => {
    // Portrait-driven, clip-driven and two-speaker models all run under the
    // one mode, and each collects a different set.
    expect(videoSlotsForModel(model({ image: PICTURE, audio: TRACK }), 'talking_head')).toEqual([
      'characterImage',
      'drivingAudio',
    ]);
    expect(videoSlotsForModel(model({ video: CLIP, audio: TRACK }), 'talking_head')).toEqual([
      'sourceVideo',
      'drivingAudio',
    ]);
    expect(
      videoSlotsForModel(
        model({ image: PICTURE, left_audio: TRACK, right_audio: TRACK }),
        'talking_head',
      ),
    ).toEqual(['characterImage', 'leftAudio', 'rightAudio']);
  });

  it('draws the mode\'s whole row while no model resolves', () => {
    expect(videoSlotsForModel(undefined, 'first_last')).toEqual(['firstFrame', 'endFrame']);
  });
});
