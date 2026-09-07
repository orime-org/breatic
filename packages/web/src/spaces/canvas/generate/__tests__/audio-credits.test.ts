// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the audio panel prints beside the star.
 *
 * Two kinds of model sit on this one panel. One bills by how much it is given,
 * and what it counts differs per vendor: ElevenLabs per character, Fish per
 * UTF-8 byte (a Chinese character is three of those), Sonilo per second of the
 * clip the user asked for. The other bills a flat sum per call, the way every
 * model on the image and video panels does.
 *
 * So the estimate reads the model, not a rate handed to it: a rate when the
 * model states one, `cost_per_call` when it does not (#1960). Before this the
 * function took the rate alone and answered undefined without one, which made
 * the panel drop the whole line — the two music models and `elevenlabs-sfx-v2`
 * would have shown no price at all.
 */

import { describe, it, expect } from 'vitest';

import type { ModelEntry, ModelRate } from '@breatic/shared';

import { estimateAudioCredits } from '@web/spaces/canvas/generate/audio-credits';

const PER_CHARACTER: ModelRate = {
  credits: 10,
  per: 1000,
  unit: 'characters',
};
const PER_BYTE: ModelRate = { credits: 3, per: 1000, unit: 'utf8_bytes' };
const PER_SECOND: ModelRate = { credits: 1, per: 5, unit: 'seconds' };

/**
 * Builds an audio model the way the catalog serves one.
 * @param costPerCall - The flat sum this model bills per generation.
 * @param rate - What it bills per unit, on a model that states one.
 * @returns A model entry.
 */
function audioModel(costPerCall: number, rate?: ModelRate): ModelEntry {
  return {
    name: 'a-model',
    display_name: 'A Model',
    modality: 'tts',
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: costPerCall,
    generation_time: 0,
    takes_prompt: true,
    params: {},
    providers: [],
    sourcesByMode: {},
    ...(rate ? { rate } : {}),
  };
}

describe('estimateAudioCredits', () => {
  it('scales with the prompt, so 2000 characters cost twice what 1000 do', () => {
    const model = audioModel(0, PER_CHARACTER);
    expect(estimateAudioCredits(model, { text: 'a'.repeat(1000) })).toBe(10);
    expect(estimateAudioCredits(model, { text: 'a'.repeat(2000) })).toBe(20);
    expect(estimateAudioCredits(model, { text: 'a'.repeat(500) })).toBe(5);
  });

  it('costs nothing before anything is typed', () => {
    expect(estimateAudioCredits(audioModel(0, PER_CHARACTER), { text: '' })).toBe(0);
  });

  it('counts a vendor that bills by byte in bytes', () => {
    // A Chinese character is three UTF-8 bytes, so the same 1000 characters
    // reach this vendor as 3000 units.
    const model = audioModel(0, PER_BYTE);
    expect(estimateAudioCredits(model, { text: '好'.repeat(1000) })).toBe(9);
    expect(estimateAudioCredits(model, { text: 'a'.repeat(1000) })).toBe(3);
  });

  it('counts one emoji as one character, not as the two units it stores as', () => {
    expect(
      estimateAudioCredits(audioModel(0, PER_CHARACTER), { text: '🙂'.repeat(1000) }),
    ).toBe(10);
  });

  it('rounds a part-unit up, since a fraction of a credit is not charged', () => {
    const model = audioModel(0, PER_CHARACTER);
    expect(estimateAudioCredits(model, { text: 'a'.repeat(1) })).toBe(1);
    expect(estimateAudioCredits(model, { text: 'a'.repeat(1001) })).toBe(11);
  });

  // A sound effect is priced by the length asked for, not by the description
  // (#2088 A6). $0.002 a second measured on 2026-09-04, at 1 credit = 1 cent.
  it('follows the clip length for a vendor that bills by the second', () => {
    const model = audioModel(0, PER_SECOND);
    expect(estimateAudioCredits(model, { text: 'rain', seconds: 5 })).toBe(1);
    expect(estimateAudioCredits(model, { text: 'rain', seconds: 30 })).toBe(6);
    expect(estimateAudioCredits(model, { text: 'rain', seconds: 180 })).toBe(36);
  });

  it('ignores the prompt entirely when the vendor bills by the second', () => {
    const model = audioModel(0, PER_SECOND);
    const short = estimateAudioCredits(model, { text: 'a', seconds: 10 });
    const long = estimateAudioCredits(model, { text: 'a'.repeat(5000), seconds: 10 });
    expect(short).toBe(long);
  });

  it('rounds a part-credit up here too, so 1s and 2s both read as one', () => {
    const model = audioModel(0, PER_SECOND);
    expect(estimateAudioCredits(model, { text: 'x', seconds: 1 })).toBe(1);
    expect(estimateAudioCredits(model, { text: 'x', seconds: 2 })).toBe(1);
  });

  // #1960 A8. Both music models bill a flat sum — the vendor charges the same
  // whether the brief is four words or four hundred — so they state
  // `cost_per_call` and no rate. Answering undefined here dropped the whole
  // line from the panel, which is the one place the price is stated before
  // the user spends it.
  it('falls back to the flat cost per call on a model that states no rate', () => {
    expect(estimateAudioCredits(audioModel(15), { text: 'anything' })).toBe(15);
    expect(estimateAudioCredits(audioModel(35), { text: '' })).toBe(35);
  });

  it('holds the flat cost steady however long the prompt gets', () => {
    const model = audioModel(15);
    expect(estimateAudioCredits(model, { text: 'a' })).toBe(15);
    expect(estimateAudioCredits(model, { text: 'a'.repeat(5000), seconds: 240 })).toBe(15);
  });

  it('prefers the rate over the flat cost when the model states both', () => {
    // A stated rate is the more specific answer: it is what the vendor bills.
    expect(
      estimateAudioCredits(audioModel(99, PER_CHARACTER), { text: 'a'.repeat(1000) }),
    ).toBe(10);
  });

  it('says nothing when there is no model picked yet', () => {
    expect(estimateAudioCredits(undefined, { text: 'anything' })).toBeUndefined();
  });
});
