// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the audio panel prints beside the star.
 *
 * The video panel prints one number — the model's cost per call. A tts model
 * bills by how much text it is given, so the number here follows the prompt as
 * it is typed.
 *
 * The two vendors count different units: ElevenLabs per character, Fish per
 * UTF-8 byte, and a Chinese character is three of the latter.
 */

import { describe, it, expect } from 'vitest';

import type { ModelRate } from '@breatic/shared';

import { estimateAudioCredits } from '@web/spaces/canvas/generate/audio-credits';

const PER_CHARACTER: ModelRate = {
  credits: 10,
  per: 1000,
  unit: 'characters',
};
const PER_BYTE: ModelRate = { credits: 3, per: 1000, unit: 'utf8_bytes' };

describe('estimateAudioCredits', () => {
  it('scales with the prompt, so 2000 characters cost twice what 1000 do', () => {
    expect(estimateAudioCredits(PER_CHARACTER, 'a'.repeat(1000))).toBe(10);
    expect(estimateAudioCredits(PER_CHARACTER, 'a'.repeat(2000))).toBe(20);
    expect(estimateAudioCredits(PER_CHARACTER, 'a'.repeat(500))).toBe(5);
  });

  it('costs nothing before anything is typed', () => {
    expect(estimateAudioCredits(PER_CHARACTER, '')).toBe(0);
  });

  it('counts a vendor that bills by byte in bytes', () => {
    // A Chinese character is three UTF-8 bytes, so the same 1000 characters
    // reach this vendor as 3000 units.
    expect(estimateAudioCredits(PER_BYTE, '好'.repeat(1000))).toBe(9);
    expect(estimateAudioCredits(PER_BYTE, 'a'.repeat(1000))).toBe(3);
  });

  it('counts one emoji as one character, not as the two units it stores as', () => {
    expect(estimateAudioCredits(PER_CHARACTER, '🙂'.repeat(1000))).toBe(10);
  });

  it('rounds a part-unit up, since a fraction of a credit is not charged', () => {
    expect(estimateAudioCredits(PER_CHARACTER, 'a'.repeat(1))).toBe(1);
    expect(estimateAudioCredits(PER_CHARACTER, 'a'.repeat(1001))).toBe(11);
  });

  it('says nothing when the model states no rate', () => {
    expect(estimateAudioCredits(undefined, 'anything')).toBeUndefined();
  });
});
