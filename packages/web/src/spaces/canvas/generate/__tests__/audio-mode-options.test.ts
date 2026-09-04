// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — the modes the audio panel offers.
 *
 * A mode's `value` is matched against a model's `mode` field from yaml, so the
 * two spellings have to be the same string. A mode listed under a name no
 * model claims is filtered out by availability and never reaches the picker —
 * the panel would open with an empty mode list and refuse to serve anything,
 * with nothing saying why.
 */

import { describe, it, expect } from 'vitest';

import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { filterAvailableModes } from '@web/spaces/canvas/generate/mode-selection';
import type { ModelEntry } from '@breatic/shared';

/**
 * Builds a tts model the way the catalog serves one.
 * @param name - Model id.
 * @param mode - The mode string from its yaml entry.
 * @returns A model entry.
 */
function ttsModel(name: string, mode: string): ModelEntry {
  return {
    name,
    display_name: name,
    modality: 'tts',
    mode,
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 0,
    generation_time: 0,
    takes_prompt: true,
    params: {},
    providers: [],
    sourcesByMode: {},
  };
}

describe('AUDIO_MODE_OPTIONS (#1960)', () => {
  it('offers text to speech, voice cloning and sound effects', () => {
    expect(AUDIO_MODE_OPTIONS.map((o) => o.value)).toEqual([
      'tts',
      'voice_clone',
      'sfx',
    ]);
  });

  // One placeholder across all three would tell someone writing a sound effect
  // to "write the lines to speak" (#2088 A3). The key travels with the mode
  // rather than being chosen in the container, so a mode added later cannot
  // reach the picker without one.
  it('gives each mode its own prompt placeholder', () => {
    const keys = AUDIO_MODE_OPTIONS.map((o) => o.placeholderKey);
    expect(keys.every((k) => k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(AUDIO_MODE_OPTIONS.length);
  });

  it('spells each mode the way the models in the catalog do', () => {
    // The three tts models declare these strings in config/models/tts/:
    // elevenlabs-v3 and fish-s2-pro say `tts`, qwen3 says `voice_clone`.
    const models = [
      ttsModel('elevenlabs-v3', 'tts'),
      ttsModel('fish-s2-pro', 'tts'),
      ttsModel('qwen3-tts-voice-clone', 'voice_clone'),
    ];
    expect(filterAvailableModes(AUDIO_MODE_OPTIONS, models)).toHaveLength(2);
  });

  it('drops sound effects when no model in the catalog serves it', () => {
    // The sfx model lives in the `audio` bucket, and its provider is WaveSpeed.
    // A deployment without that key serves the two speech modes alone.
    const speechOnly = [ttsModel('elevenlabs-v3', 'tts')];
    expect(
      filterAvailableModes(AUDIO_MODE_OPTIONS, speechOnly).map((o) => o.value),
    ).not.toContain('sfx');
  });

  it('offers sound effects once a model claims that mode', () => {
    const withSfx = [ttsModel('sonilo-sfx-v1', 'sfx')];
    expect(
      filterAvailableModes(AUDIO_MODE_OPTIONS, withSfx).map((o) => o.value),
    ).toEqual(['sfx']);
  });

  it('drops cloning when no model in the catalog serves it', () => {
    // A deployment whose qwen3 provider has no key serves text to speech alone,
    // and the picker must not offer a mode that cannot run.
    const ttsOnly = [ttsModel('elevenlabs-v3', 'tts')];
    expect(filterAvailableModes(AUDIO_MODE_OPTIONS, ttsOnly).map((o) => o.value)).toEqual([
      'tts',
    ]);
  });

  it('gives every option a label and a test id, like the other two panels', () => {
    for (const option of AUDIO_MODE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.testId).toMatch(/^generate-audio-mode-/);
    }
  });
});
