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
  stability: { description: '', min: 0, max: 1, step: 0.05, default: 0.5 },
  similarity: { description: '', min: 0, max: 1, step: 0.05, default: 0.75 },
});
const FISH = model({
  reference_id: { description: '', default: null, remote_source: 'voices' },
  speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
  volume: { description: '', min: -20, max: 20, step: 1, default: 0 },
});

describe('audioParamControls — each model states its own speaking params', () => {
  it('reads ElevenLabs\' pair, both ranges, stability carrying its stops', () => {
    expect(audioParamControls(ELEVENLABS)).toEqual([
      {
        name: 'stability',
        labelKey: 'canvas.generatePanel.voiceStability',
        kind: 'range',
        min: 0,
        max: 1,
        step: 0.05,
        // The vendor describes these three positions and no others, so the
        // slider names them where they sit rather than leaving a reader to
        // guess what 0.50 sounds like.
        stops: [
          { value: 0, labelKey: 'canvas.generatePanel.voiceStabilityCreative' },
          { value: 0.5, labelKey: 'canvas.generatePanel.voiceStabilityNatural' },
          { value: 1, labelKey: 'canvas.generatePanel.voiceStabilityRobust' },
        ],
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

  it('leaves a range without stops when nobody named a position on it', () => {
    // Similarity runs the same 0-1 as stability and has no named positions:
    // the stops belong to the param, not to the shape of the control.
    const similarity = audioParamControls(ELEVENLABS).find(
      (c) => c.name === 'similarity',
    );
    expect(similarity).not.toHaveProperty('stops');
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

// Stands in for the app's translator: returns what the shipped catalogs say
// for the one key this module reaches for, and the key itself otherwise.
const t = (
  key: string,
  params?: Record<string, string | number | Date>,
): string =>
  key === 'canvas.generatePanel.durationSeconds'
    ? `${String(params?.n)} 秒`
    : key;

describe('formatAudioParam — a value reads in its own unit', () => {
  it('reads the two 0-1 params to two decimals', () => {
    expect(formatAudioParam('stability', 0.5, t)).toBe('0.50');
    expect(formatAudioParam('similarity', 0.75, t)).toBe('0.75');
  });

  it('marks speed as a multiplier', () => {
    expect(formatAudioParam('speed', 1, t)).toBe('1.00x');
  });

  it('marks volume in decibels, signed above zero', () => {
    expect(formatAudioParam('volume', 0, t)).toBe('0 dB');
    expect(formatAudioParam('volume', 5, t)).toBe('+5 dB');
    expect(formatAudioParam('volume', -5, t)).toBe('-5 dB');
  });

  it('falls back to the bare number for a param it does not know', () => {
    expect(formatAudioParam('latency_mode', 2, t)).toBe('2');
  });

  // A clip length reads in the reader's own language. The video panel already
  // renders the same quantity through this key, and all five catalogs carry a
  // translation for it — `x` and `dB` have none, which is what makes them
  // symbols rather than words.
  it('reads a clip length through the shared duration key', () => {
    expect(formatAudioParam('duration', 5, t)).toBe('5 秒');
    expect(formatAudioParam('duration', 180, t)).toBe('180 秒');
  });

  it('hands the number to the translator as the ICU parameter', () => {
    const calls: { key: string; params?: Record<string, unknown> }[] = [];
    const spy = (
      key: string,
      params?: Record<string, string | number | Date>,
    ): string => {
      calls.push({ key, params });
      return 'x';
    };
    formatAudioParam('duration', 30, spy);
    expect(calls).toEqual([
      { key: 'canvas.generatePanel.durationSeconds', params: { n: 30 } },
    ]);
  });
});

// The sound-effect model states its length as a list of presets, which is the
// shape ElevenLabs' own playground offers and the shape ParamOptionGroup
// renders (#2088 A4).
const SONILO = model({
  duration: {
    description: '',
    values: [1, 2, 5, 10, 15, 20, 30, 60, 120, 180],
    default: 5,
  },
  audio_format: { description: '', default: 'mp3' },
});

describe('the sound-effect model gets a length picker (#2088 A4)', () => {
  it('offers its ten presets as a choice, in the order the model states', () => {
    expect(audioParamControls(SONILO)).toEqual([
      {
        name: 'duration',
        labelKey: 'canvas.generatePanel.sfxDuration',
        kind: 'choice',
        options: [1, 2, 5, 10, 15, 20, 30, 60, 120, 180],
      },
    ]);
  });

  it('leaves out the output format, which the user does not choose', () => {
    expect(audioParamControls(SONILO).map((c) => c.name)).not.toContain('audio_format');
  });
});
