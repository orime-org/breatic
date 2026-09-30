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
  it('draws the slots of the mode row its model declares, in the row\'s order', () => {
    const song = model({
      melody: REFERENCE,
      song: REFERENCE,
      vocal: REFERENCE,
    });

    expect(audioSlotsForModel(song, 'a2m')).toEqual([
      'musicSong',
      'musicMelody',
      'musicVocal',
    ]);
    expect(audioSlotsForModel(song, 't2m')).toEqual([]);
  });

  it('gives one param to whichever slot the mode row names for it', () => {
    // `audio` is the voice sample under Voice Cloning and the song to cover
    // under Reference to Music: the mode row decides which place draws it.
    const takesAudio = model({
      audio: { description: '', default: null, fill: 'canvas', accepts: 'audio' },
    });

    expect(audioSlotsForModel(takesAudio, 'voice_clone')).toEqual(['refAudio']);
    expect(audioSlotsForModel(takesAudio, 'a2m')).toEqual(['coverSong']);
  });

  it('draws the video slot for sound effects and the image slot for text to music', () => {
    const video = model({
      video: { description: '', default: null, fill: 'canvas', accepts: 'video' },
    });
    const image = model({
      image: { description: '', default: null, fill: 'canvas', accepts: 'image', optional: true },
    });

    expect(audioSlotsForModel(video, 'sfx')).toEqual(['soundVideo']);
    expect(audioSlotsForModel(video, 'a2m')).toEqual(['soundVideo']);
    expect(audioSlotsForModel(image, 't2m')).toEqual(['moodImage']);
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
      vocal: { ...REFERENCE, optional: true },
    });

    expect(audioSlotsForModel(music, 'a2m')).toEqual(['musicSong', 'musicVocal']);
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
        vocal: { ...REFERENCE, optional: true },
      }),
      source_groups: [{ mode: 'a2m', any_of: ['song', 'vocal'] }],
    };

    expect(audioMissing(music, 'a2m', {})).toEqual([['song', 'vocal']]);
    expect(audioMissing(music, 'a2m', { musicVocal: 'https://v.mp3' })).toEqual([]);
  });

  it('needs nothing when no model resolves', () => {
    expect(audioMissing(undefined, 'a2m', {})).toEqual([]);
  });
});
