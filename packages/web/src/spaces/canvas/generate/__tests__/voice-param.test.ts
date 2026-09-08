// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — how the panel finds, and reads, the param the voice picker fills.
 *
 * The two tts models spell the same choice differently (ElevenLabs takes
 * `voice_id`, Fish takes `reference_id`), so the picker locates its param by
 * the `remote_source` marker rather than by name. Writing one shared name
 * instead would be silent: `shared.ts` drops a param the model never declared
 * and the request goes out with the vendor's own default voice.
 *
 * Whether a voice is chosen is read off the per-model RECORD, not off the
 * resolved value. Resolution falls back to the yaml default, and neither
 * default is a voice this deployment can use — Fish declares `null`, and
 * ElevenLabs declares `"Alice"`, a display name the direct connection rejects.
 * A resolved-value check would call both of those "chosen".
 */

import { describe, it, expect } from 'vitest';

import {
  voiceParamName,
  isVoiceChosen,
} from '@web/spaces/canvas/generate/voice-param';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

/**
 * Builds a model entry carrying the given params.
 * @param params - The param declarations to expose.
 * @returns A model entry shaped the way the sanitized catalog serves one.
 */
function modelWith(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'a-model',
    display_name: 'A model',
    modality: 'tts',
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 0,
    generation_time: 0,
    takes_prompt: true,
    params,
    providers: [],
    sourcesByMode: {},
  };
}

describe('voiceParamName (#1960 A2)', () => {
  it('finds the elevenlabs param by its marker, not by its name', () => {
    const model = modelWith({
      stability: { description: '', default: 0.5 },
      voice_id: { description: '', default: 'Alice', remote_source: 'voices' },
    });
    expect(voiceParamName(model)).toBe('voice_id');
  });

  it('finds the fish param, which is spelled differently', () => {
    const model = modelWith({
      speed: { description: '', default: 1 },
      reference_id: { description: '', default: null, remote_source: 'voices' },
    });
    expect(voiceParamName(model)).toBe('reference_id');
  });

  it('answers null for a model with no voice param, so no picker renders', () => {
    const model = modelWith({
      aspect_ratio: { description: '', values: ['1:1'], default: '1:1' },
    });
    expect(voiceParamName(model)).toBeNull();
  });

  it('answers null when no model is selected yet', () => {
    expect(voiceParamName(undefined)).toBeNull();
  });

  it('ignores a param whose marker names some other catalog', () => {
    // `remote_source` is an open enum by design: a value this build does not
    // know is coerced to undefined at the API boundary. A param that reached
    // here with a different marker still must not be treated as the voice.
    const model = modelWith({
      seed: {
        description: '',
        default: 0,
        remote_source: 'palettes' as unknown as 'voices',
      },
    });
    expect(voiceParamName(model)).toBeNull();
  });
});

describe('isVoiceChosen (#1960 A12)', () => {
  it('says yes once the picker has written an id into the record', () => {
    expect(isVoiceChosen({ voice_id: 'JBFqnCBsd6RMkjVDRZzb' }, 'voice_id')).toBe(
      true,
    );
  });

  it('says no for a record that has never held this param', () => {
    expect(isVoiceChosen({ stability: 0.5 }, 'voice_id')).toBe(false);
  });

  it('says no for a node that has no record for this model at all', () => {
    expect(isVoiceChosen(undefined, 'voice_id')).toBe(false);
  });

  it('says no for the fish default of null, which sends no voice at all', () => {
    // transports/fish.ts guards on `if (params.reference_id)`, so null drops
    // the field and the vendor picks its own voice with nothing said.
    expect(isVoiceChosen({ reference_id: null }, 'reference_id')).toBe(false);
  });

  it('says no for an empty string, which reaches the vendor as no choice', () => {
    expect(isVoiceChosen({ voice_id: '' }, 'voice_id')).toBe(false);
  });

  it('says no for a non-string, whatever put it there', () => {
    expect(isVoiceChosen({ voice_id: 42 }, 'voice_id')).toBe(false);
  });
});
