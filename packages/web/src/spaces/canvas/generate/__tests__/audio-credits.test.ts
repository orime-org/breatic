// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the audio panel prints beside the star.
 *
 * The video panel prints one number — the model's cost per call. An audio
 * model bills by how much it is given, and what it counts differs per vendor:
 * ElevenLabs per character, Fish per UTF-8 byte (a Chinese character is three
 * of those), Sonilo per second of the clip the user asked for.
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
const PER_SECOND: ModelRate = { credits: 1, per: 5, unit: 'seconds' };

describe('estimateAudioCredits', () => {
  it('scales with the prompt, so 2000 characters cost twice what 1000 do', () => {
    expect(estimateAudioCredits(PER_CHARACTER, { text: 'a'.repeat(1000) })).toBe(10);
    expect(estimateAudioCredits(PER_CHARACTER, { text: 'a'.repeat(2000) })).toBe(20);
    expect(estimateAudioCredits(PER_CHARACTER, { text: 'a'.repeat(500) })).toBe(5);
  });

  it('costs nothing before anything is typed', () => {
    expect(estimateAudioCredits(PER_CHARACTER, { text: '' })).toBe(0);
  });

  it('counts a vendor that bills by byte in bytes', () => {
    // A Chinese character is three UTF-8 bytes, so the same 1000 characters
    // reach this vendor as 3000 units.
    expect(estimateAudioCredits(PER_BYTE, { text: '好'.repeat(1000) })).toBe(9);
    expect(estimateAudioCredits(PER_BYTE, { text: 'a'.repeat(1000) })).toBe(3);
  });

  it('counts one emoji as one character, not as the two units it stores as', () => {
    expect(estimateAudioCredits(PER_CHARACTER, { text: '🙂'.repeat(1000) })).toBe(10);
  });

  it('rounds a part-unit up, since a fraction of a credit is not charged', () => {
    expect(estimateAudioCredits(PER_CHARACTER, { text: 'a'.repeat(1) })).toBe(1);
    expect(estimateAudioCredits(PER_CHARACTER, { text: 'a'.repeat(1001) })).toBe(11);
  });

  it('says nothing when the model states no rate', () => {
    expect(estimateAudioCredits(undefined, { text: 'anything' })).toBeUndefined();
  });

  // A sound effect is priced by the length asked for, not by the description
  // (#2088 A6). $0.002 a second measured on 2026-09-04, at 1 credit = 1 cent.
  it('follows the clip length for a vendor that bills by the second', () => {
    expect(estimateAudioCredits(PER_SECOND, { text: 'rain', seconds: 5 })).toBe(1);
    expect(estimateAudioCredits(PER_SECOND, { text: 'rain', seconds: 30 })).toBe(6);
    expect(estimateAudioCredits(PER_SECOND, { text: 'rain', seconds: 180 })).toBe(36);
  });

  it('ignores the prompt entirely when the vendor bills by the second', () => {
    const short = estimateAudioCredits(PER_SECOND, { text: 'a', seconds: 10 });
    const long = estimateAudioCredits(PER_SECOND, { text: 'a'.repeat(5000), seconds: 10 });
    expect(short).toBe(long);
  });

  it('rounds a part-credit up here too, so 1s and 2s both read as one', () => {
    expect(estimateAudioCredits(PER_SECOND, { text: 'x', seconds: 1 })).toBe(1);
    expect(estimateAudioCredits(PER_SECOND, { text: 'x', seconds: 2 })).toBe(1);
  });
});
