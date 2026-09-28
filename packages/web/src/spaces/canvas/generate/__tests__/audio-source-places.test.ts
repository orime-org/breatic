// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an audio run collects, off the model that declares it (#269).
 *
 * The panel's registry says what each place is called and what to draw in it;
 * which of them a mode has, and whether it opens a lyrics box, is per model.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import { describe, it, expect } from 'vitest';

import {
  audioMissing,
  audioSlotsForModel,
  modelTakesLyrics,
} from '@web/spaces/canvas/generate/audio-slots';

/**
 * An audio model declaring the given params.
 * @param params - What it declares.
 * @returns The catalog entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'a-model',
    display_name: 'A Model',
    modality: 'audio',
    mode: ['a2m', 't2m'],
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 10,
    takes_prompt: true,
    params,
    providers: [],
  };
}

const REFERENCE: ParamDescriptor = {
  description: '',
  default: null,
  fill: 'canvas',
  accepts: 'audio',
  modes: ['a2m'],
};

describe('what an audio run collects', () => {
  it('offers the places the model declares for this mode', () => {
    const music = model({
      song: REFERENCE,
      voice: REFERENCE,
      instrumental: REFERENCE,
    });

    expect(audioSlotsForModel(music, 'a2m')).toEqual([
      'musicSong',
      'musicVoice',
      'musicInstrumental',
    ]);
    expect(audioSlotsForModel(music, 't2m')).toEqual([]);
  });

  it('offers only the ones the model has', () => {
    const oneOnly = model({ song: REFERENCE });

    expect(audioSlotsForModel(oneOnly, 'a2m')).toEqual(['musicSong']);
    expect(audioSlotsForModel(undefined, 'a2m')).toEqual([]);
  });

  it('opens a lyrics box where the model keeps one', () => {
    const singing = model({
      lyrics: { description: '', default: '', fill: 'editor', modes: ['t2m'] },
    });

    expect(modelTakesLyrics(singing, 't2m')).toBe(true);
    expect(modelTakesLyrics(singing, 'a2m')).toBe(false);
  });

  it('opens none for a model that keeps the words nowhere', () => {
    expect(modelTakesLyrics(model({}), 't2m')).toBe(false);
    // A parameter the panel fills with an ordinary control is not the box.
    expect(modelTakesLyrics(model({ lyrics: { description: '', default: '', fill: 'panel' } }), 't2m'))
      .toBe(false);
  });
});

describe('what an audio run still needs', () => {
  it('asks for a place the model does not mark optional', () => {
    const music = model({
      song: REFERENCE,
      voice: { ...REFERENCE, optional: true },
    });

    expect(audioSlotsForModel(music, 'a2m')).toEqual(['musicSong', 'musicVoice']);
    expect(audioMissing(music, 'a2m', {})).toEqual([['song']]);
  });

  it('counts a filled place as filled', () => {
    const music = model({ song: REFERENCE });

    expect(audioMissing(music, 'a2m', { musicSong: 'https://a.mp3' })).toEqual([]);
  });

  it('asks nothing of a place this mode does not collect', () => {
    expect(audioMissing(model({ song: REFERENCE }), 't2m', {})).toEqual([]);
  });

  it('asks for any one of a group the model declares for the mode', () => {
    const music: ModelEntry = {
      ...model({
        song: { ...REFERENCE, optional: true },
        voice: { ...REFERENCE, optional: true },
      }),
      source_groups: [{ mode: 'a2m', any_of: ['song', 'voice'] }],
    };

    expect(audioMissing(music, 'a2m', {})).toEqual([['song', 'voice']]);
    expect(audioMissing(music, 'a2m', { musicVoice: 'https://v.mp3' })).toEqual([]);
  });

  it('needs nothing when no model resolves', () => {
    expect(audioMissing(undefined, 'a2m', {})).toEqual([]);
  });
});
