// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 §6.9 — which catalog buckets a panel's modality reads.
 *
 * A panel used to map one-to-one onto a bucket. Audio does not: the modes it
 * offers live in two of them, tts (text to speech, voice cloning) and audio (sound
 * effects, music). Two places read those buckets — the frame's gate, which
 * decides whether a panel may open at all, and each container's own model
 * list — and the gate's comment says it "reads the same lists the picker
 * reads rather than a second copy that could drift". One list of buckets
 * written twice is that second copy.
 */

import { describe, it, expect } from 'vitest';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';

import {
  modelsForModality,
  MODALITY_BUCKETS,
} from '@web/spaces/canvas/generate/modality-buckets';

/**
 * Builds a minimal catalog entry.
 * @param name - Model id.
 * @param modality - Bucket it belongs to.
 * @returns A model entry.
 */
function model(name: string, modality: ModelEntry['modality']): ModelEntry {
  return {
    name,
    display_name: name,
    modality,
    mode: 'generate',
    description: '',
    guide: '',
    tier: 'optional',
    cost_per_call: 0,
    generation_time: 0,
    takes_prompt: true,
    params: {},
    providers: [],
    sourcesByMode: {},
  };
}

const CATALOG: ModelCatalog = {
  image: [model('flux', 'image')],
  video: [model('kling', 'video')],
  tts: [model('elevenlabs-v3', 'tts'), model('fish-s2-pro', 'tts')],
  audio: [model('minimax-music-2.5', 'audio')],
  three_d: [],
  understand: [],
  total: 5,
};

describe('modelsForModality (#1960 §6.9)', () => {
  it('reads one bucket for image, exactly as before', () => {
    expect(modelsForModality(CATALOG, 'image').map((m) => m.name)).toEqual(['flux']);
  });

  it('reads one bucket for video, exactly as before', () => {
    expect(modelsForModality(CATALOG, 'video').map((m) => m.name)).toEqual(['kling']);
  });

  it('reads both of audio’s buckets, since its modes span them', () => {
    expect(modelsForModality(CATALOG, 'audio').map((m) => m.name)).toEqual([
      'elevenlabs-v3',
      'fish-s2-pro',
      'minimax-music-2.5',
    ]);
  });

  it('answers with an empty list while no catalog has arrived', () => {
    expect(modelsForModality(undefined, 'audio')).toEqual([]);
  });

  it('survives a bucket the catalog left out', () => {
    const partial = { ...CATALOG, audio: undefined } as unknown as ModelCatalog;
    expect(modelsForModality(partial, 'audio').map((m) => m.name)).toEqual([
      'elevenlabs-v3',
      'fish-s2-pro',
    ]);
  });

  it('declares a bucket list for every modality a panel serves', () => {
    // A modality added to the union without a bucket entry would read nothing
    // and open a panel with an empty picker.
    for (const buckets of Object.values(MODALITY_BUCKETS)) {
      expect(buckets.length).toBeGreaterThan(0);
    }
  });
});
