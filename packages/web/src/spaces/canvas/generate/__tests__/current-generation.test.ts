// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a node's panel would run right now: the mode, model and params in
 * effect. The attach snapshot reports this beside
 * the node's stored data, resolved by the rules the panels resolve by.
 */

import { describe, it, expect } from 'vitest';
import type { ModelCatalog, ModelEntry, ParamDescriptor } from '@breatic/shared';

import { currentGeneration } from '@web/spaces/canvas/generate/current-generation';

/**
 * A video model serving the given modes.
 * @param name - Its id.
 * @param mode - The modes it serves.
 * @param params - Its params.
 * @returns The entry.
 */
function video(name: string, mode: string[], params: Record<string, ParamDescriptor> = {}): ModelEntry {
  return {
    name,
    display_name: name,
    modality: 'video',
    mode,
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 10,
    takes_prompt: true,
    params: { duration: { description: '', default: 5, values: [3, 5], fill: 'panel' }, ...params },
    providers: [],
  };
}

const kling = video('kling', ['t2v', 'multi_shot'], {
  multi_prompt: { description: '', default: null, type: 'items', max_items: 6, modes: ['multi_shot'], fill: 'storyboard', fields: { prompt: { type: 'text' }, duration: { values: [1, 2] } } },
  shot_type: { description: '', default: null, values: ['customize'], modes: ['multi_shot'], fill: 'storyboard' },
  auto_shots: { description: '', label: 'Auto multi-shot', default: false, values: [true, false], modes: ['t2v'], fill: 'panel' },
});
const minimax = video('minimax', ['t2v']);
const STYLE: ParamDescriptor = {
  description: '',
  default: null,
  type: 'list',
  max_items: 3,
  fill: 'canvas',
  accepts: 'image',
  optional: true,
};
const seedance = video('seedance', ['t2v'], { style_images: STYLE });
const krea: ModelEntry = { ...video('krea', ['t2i'], { style_images: STYLE }), modality: 'image' };
const speech: ModelEntry = {
  ...video('speech', ['tts']),
  modality: 'audio',
  params: { voice_id: { description: '', default: null, remote_source: 'voices' } },
};
const dialogue: ModelEntry = {
  ...video('dialogue', ['tts']),
  modality: 'audio',
  params: {
    speakers: {
      description: '',
      default: null,
      type: 'items',
      min_items: 2,
      max_items: 2,
      replaces: 'voice_id',
      fields: { speaker: { type: 'text' }, voice: { values: ['Kore', 'Puck'] } },
      fill: 'panel',
    },
    voice_id: { description: '', default: 'Kore', remote_source: 'voices', fill: 'remote' },
  },
};
const catalog = { image: [krea], video: [kling, minimax, seedance], audio: [speech, dialogue], tts: [], three_d: [], total: 4, credit_multiplier: 1 } as unknown as ModelCatalog;
const TWO = [{ speaker: 'A', voice: 'Kore' }, { speaker: 'B', voice: 'Puck' }];

/**
 * A voice list that has nothing to offer.
 * @returns Nothing.
 */
function noVoice(): undefined {
  return undefined;
}

describe('what a node would run right now', () => {
  it('falls back to the first served mode and model when nothing is stored', () => {
    const now = currentGeneration('video', { kind: 'video', status: 'idle' } as never, catalog, noVoice);
    expect(now).toMatchObject({ mode: 't2v', model: 'kling', params: { duration: 5 } });
  });

  it('leaves out a param declared for another mode, as the run does', () => {
    const content = { kind: 'video', status: 'idle', model: 'kling', paramsByModel: { kling: { duration: 3, auto_shots: true } } };
    const inT2v = currentGeneration('video', { ...content, mode: 't2v' } as never, catalog, noVoice);
    expect(inT2v?.params).toMatchObject({ duration: 3, auto_shots: true });
    const inMultiShot = currentGeneration('video', { ...content, mode: 'multi_shot' } as never, catalog, noVoice);
    expect(inMultiShot).toMatchObject({ mode: 'multi_shot', model: 'kling', params: { duration: 3 } });
    expect(inMultiShot?.params).not.toHaveProperty('auto_shots');
  });

  it('sends the first listed voice when nobody picked one, as the audio panel does', () => {
    const now = currentGeneration('audio', { kind: 'audio', status: 'idle', mode: 'tts' } as never, catalog, () => ({ id: 'first' }));
    expect(now).toMatchObject({ mode: 'tts', model: 'speech', params: { voice_id: 'first' } });
  });

  it('keeps the voice the reader picked', () => {
    const now = currentGeneration(
      'audio',
      { kind: 'audio', status: 'idle', mode: 'tts', model: 'speech', paramsByModel: { speech: { voice_id: 'mine' } } } as never,
      catalog,
      () => ({ id: 'first' }),
    );
    expect(now?.params).toMatchObject({ voice_id: 'mine' });
  });

  it('names the speakers and not the single voice while dialogue is on, as the run sends', () => {
    const now = currentGeneration(
      'audio',
      {
        kind: 'audio', status: 'idle', mode: 'tts', model: 'dialogue',
        paramsByModel: { dialogue: { voice_id: 'Puck', speakers: TWO, _stand_in_on: true } },
      } as never,
      catalog,
      noVoice,
    );
    expect(now?.params).toMatchObject({ speakers: TWO });
    expect(now?.params).not.toHaveProperty('voice_id');
    expect(now?.params).not.toHaveProperty('_stand_in_on');
  });

  it('names the single voice and not the speakers while dialogue is off', () => {
    const now = currentGeneration(
      'audio',
      {
        kind: 'audio', status: 'idle', mode: 'tts', model: 'dialogue',
        paramsByModel: { dialogue: { voice_id: 'Puck', speakers: TWO } },
      } as never,
      catalog,
      noVoice,
    );
    expect(now?.params).toMatchObject({ voice_id: 'Puck' });
    expect(now?.params).not.toHaveProperty('speakers');
  });

  it('sends the style images a video model takes, up to its cap (inner#828)', () => {
    const now = currentGeneration(
      'video',
      { kind: 'video', status: 'idle', mode: 't2v', model: 'seedance', styleImageUrls: ['s1', 's2', 's3', 's4'] } as never,
      catalog,
      noVoice,
    );
    expect(now?.params.style_images).toEqual(['s1', 's2', 's3']);
  });

  it('sends the style images an image model takes (inner#826)', () => {
    const now = currentGeneration(
      'image',
      { kind: 'image', status: 'idle', mode: 't2i', model: 'krea', styleImageUrls: ['s1'] } as never,
      catalog,
      noVoice,
    );
    expect(now?.params.style_images).toEqual(['s1']);
  });

  it('sends no style images on a model without the slot, though the node keeps them', () => {
    const now = currentGeneration(
      'video',
      { kind: 'video', status: 'idle', mode: 't2v', model: 'minimax', styleImageUrls: ['s1'] } as never,
      catalog,
      noVoice,
    );
    expect(now?.params.style_images).toBeUndefined();
  });

  it('is null without a catalog', () => {
    expect(currentGeneration('video', { kind: 'video', status: 'idle' } as never, undefined, noVoice)).toBeNull();
  });
});
