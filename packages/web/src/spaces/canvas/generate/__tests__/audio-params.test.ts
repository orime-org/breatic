// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import {
  audioParamControls,
  formatAudioParam,
} from '@web/spaces/canvas/generate/audio-params';

/**
 * A tts model declaring the given params.
 * @param params - The model's param descriptors.
 * @returns A model entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'tts',
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 10,
    generation_time: 30,
    takes_prompt: true,
    params,
    providers: [],
    sourcesByMode: {},
  };
}

// The two shipped tts models, as their yaml declares them.
const ELEVENLABS = model({
  voice_id: { description: '', default: 'Alice', remote_source: 'voices' },
  stability: { description: '', values: [0, 0.5, 1], default: 0.5 },
  similarity: { description: '', min: 0, max: 1, step: 0.05, default: 0.75 },
});
const FISH = model({
  reference_id: { description: '', default: null, remote_source: 'voices' },
  speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
  volume: { description: '', min: -20, max: 20, step: 1, default: 0 },
});

describe('audioParamControls — each model states its own speaking params', () => {
  it('reads ElevenLabs\' pair: stability as named stops, similarity as a range', () => {
    expect(audioParamControls(ELEVENLABS)).toEqual([
      {
        name: 'stability',
        labelKey: 'canvas.generatePanel.voiceStability',
        kind: 'choice',
        options: [0, 0.5, 1],
      },
      {
        name: 'similarity',
        labelKey: 'canvas.generatePanel.voiceSimilarity',
        kind: 'range',
        min: 0,
        max: 1,
        step: 0.05,
      },
    ]);
  });

  it('reads Fish\'s pair: speed and volume, both ranges', () => {
    expect(audioParamControls(FISH)).toEqual([
      {
        name: 'speed',
        labelKey: 'canvas.generatePanel.voiceSpeed',
        kind: 'range',
        min: 0.5,
        max: 2,
        step: 0.05,
      },
      {
        name: 'volume',
        labelKey: 'canvas.generatePanel.voiceVolume',
        kind: 'range',
        min: -20,
        max: 20,
        step: 1,
      },
    ]);
  });

  it('leaves out the voice param — another control fills that one', () => {
    // The voice is picked from a live list, by VoicePicker. It is in the same
    // `params` map, so leaving it out has to be deliberate.
    const names = audioParamControls(ELEVENLABS).map((c) => c.name);
    expect(names).not.toContain('voice_id');
    expect(audioParamControls(FISH).map((c) => c.name)).not.toContain('reference_id');
  });

  it('shows nothing for a param nobody has named', () => {
    // Rendering an unnamed param would put its internal catalog name on screen
    // in every locale.
    const controls = audioParamControls(
      model({ latency_mode: { description: '', min: 0, max: 3, step: 1, default: 0 } }),
    );
    expect(controls).toEqual([]);
  });

  it('refuses bounds with no step rather than choosing one', () => {
    // How finely a value may be set is the model's statement; a step of our
    // own would offer stops the vendor never described.
    const controls = audioParamControls(
      model({ speed: { description: '', min: 0.5, max: 2, default: 1 } }),
    );
    expect(controls).toEqual([]);
  });

  it('refuses a step of zero and an empty range — neither has a reachable stop', () => {
    expect(
      audioParamControls(model({ speed: { description: '', min: 0.5, max: 2, step: 0, default: 1 } })),
    ).toEqual([]);
    expect(
      audioParamControls(model({ speed: { description: '', min: 2, max: 2, step: 0.1, default: 2 } })),
    ).toEqual([]);
  });

  it('refuses non-finite bounds', () => {
    expect(
      audioParamControls(
        model({ speed: { description: '', min: 0.5, max: Infinity, step: 0.05, default: 1 } }),
      ),
    ).toEqual([]);
  });

  it('drops non-numeric stops from a values list', () => {
    const controls = audioParamControls(
      model({ stability: { description: '', values: [0, 'high', 1], default: 0 } }),
    );
    expect(controls).toEqual([
      {
        name: 'stability',
        labelKey: 'canvas.generatePanel.voiceStability',
        kind: 'choice',
        options: [0, 1],
      },
    ]);
  });

  it('shows nothing when no stop in the list is a number', () => {
    const controls = audioParamControls(
      model({ stability: { description: '', values: ['high', 'low'], default: 'high' } }),
    );
    expect(controls).toEqual([]);
  });

  it('prefers a values list over bounds, as paramValues does', () => {
    const controls = audioParamControls(
      model({
        stability: { description: '', values: [0, 1], min: 0, max: 1, step: 0.1, default: 0 },
      }),
    );
    expect(controls[0]?.kind).toBe('choice');
  });

  it('orders controls by the table, not by the model', () => {
    // Two models declaring the same pair must present it the same way round.
    const reversed = model({
      volume: { description: '', min: -20, max: 20, step: 1, default: 0 },
      speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
    });
    expect(audioParamControls(reversed).map((c) => c.name)).toEqual(['speed', 'volume']);
  });
});

describe('formatAudioParam — a value reads in its own unit', () => {
  it('reads the two 0-1 params to two decimals', () => {
    expect(formatAudioParam('stability', 0.5)).toBe('0.50');
    expect(formatAudioParam('similarity', 0.75)).toBe('0.75');
  });

  it('marks speed as a multiplier', () => {
    expect(formatAudioParam('speed', 1)).toBe('1.00x');
  });

  it('marks volume in decibels, signed above zero', () => {
    expect(formatAudioParam('volume', 0)).toBe('0 dB');
    expect(formatAudioParam('volume', 5)).toBe('+5 dB');
    expect(formatAudioParam('volume', -5)).toBe('-5 dB');
  });

  it('falls back to the bare number for a param it does not know', () => {
    expect(formatAudioParam('latency_mode', 2)).toBe('2');
  });
});
