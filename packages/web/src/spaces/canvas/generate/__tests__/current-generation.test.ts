// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a node's panel would run right now: the mode, model, params and
 * storyboard tier in effect (#2218). The attach snapshot reports this beside
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

const kling = video('kling', ['t2v'], {
  multi_prompt: { description: '', default: null, type: 'items', max_items: 6, fill: 'storyboard', fields: { prompt: { type: 'text' }, duration: { values: [1, 2] } } },
  shot_type: { description: '', default: null, values: ['intelligence', 'customize'], fill: 'storyboard' },
});
const minimax = video('minimax', ['t2v']);
const speech: ModelEntry = {
  ...video('speech', ['tts']),
  modality: 'audio',
  params: { voice_id: { description: '', default: null, remote_source: 'voices' } },
};
const catalog = { image: [], video: [kling, minimax], audio: [speech], tts: [], three_d: [], total: 3, credit_multiplier: 1 } as unknown as ModelCatalog;

/**
 * A voice list that has nothing to offer.
 * @returns Nothing.
 */
function noVoice(): undefined {
  return undefined;
}

describe('what a node would run right now', () => {
  it('falls back to the first served mode and model when nothing is stored', () => {
    const now = currentGeneration('video', { kind: 'video', status: 'idle' } as never, catalog, () => undefined, noVoice);
    expect(now).toMatchObject({ mode: 't2v', model: 'kling', params: { duration: 5 }, storyboard: 'off' });
  });

  it('reads the stored tier on a model that takes a storyboard', () => {
    const now = currentGeneration(
      'video',
      { kind: 'video', status: 'idle', mode: 't2v', model: 'kling', paramsByModel: { kling: { duration: 3 } } } as never,
      catalog,
      () => 'custom',
      noVoice,
    );
    expect(now).toMatchObject({ mode: 't2v', model: 'kling', params: { duration: 3 }, storyboard: 'custom' });
  });

  it('is off on a model that takes none, whatever tier was stored', () => {
    const now = currentGeneration(
      'video',
      { kind: 'video', status: 'idle', mode: 't2v', model: 'minimax' } as never,
      catalog,
      () => 'custom',
      noVoice,
    );
    expect(now).toMatchObject({ model: 'minimax', storyboard: 'off' });
  });

  it('sends the first listed voice when nobody picked one, as the audio panel does', () => {
    const now = currentGeneration('audio', { kind: 'audio', status: 'idle', mode: 'tts' } as never, catalog, () => undefined, () => ({ id: 'first' }));
    expect(now).toMatchObject({ mode: 'tts', model: 'speech', params: { voice_id: 'first' } });
  });

  it('keeps the voice the reader picked', () => {
    const now = currentGeneration(
      'audio',
      { kind: 'audio', status: 'idle', mode: 'tts', model: 'speech', paramsByModel: { speech: { voice_id: 'mine' } } } as never,
      catalog,
      () => undefined,
      () => ({ id: 'first' }),
    );
    expect(now?.params).toMatchObject({ voice_id: 'mine' });
  });

  it('is null without a catalog', () => {
    expect(currentGeneration('video', { kind: 'video', status: 'idle' } as never, undefined, () => undefined, noVoice)).toBeNull();
  });
});
