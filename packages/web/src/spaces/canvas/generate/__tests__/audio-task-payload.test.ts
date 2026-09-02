// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import { buildAudioTaskPayload } from '@web/spaces/canvas/generate/audio-task-payload';

/**
 * A model in the given bucket.
 * @param name - Model id.
 * @param modality - The bucket the catalog stamped on it.
 * @returns A model entry.
 */
function model(name: string, modality: ModelEntry['modality']): ModelEntry {
  return {
    name,
    display_name: name,
    modality,
    mode: 'tts',
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

const BASE = {
  nodeId: 'n1',
  projectId: 'p1',
  spaceId: 's1',
  params: {},
  promptText: 'Good evening.',
};

describe('buildAudioTaskPayload — the task type comes from the model', () => {
  it('sends tts for a model out of the tts bucket', () => {
    // The worker loads a different provider module per task type
    // (`dispatch.ts` has one case each for tts and audio), and this panel
    // serves both buckets — so a panel-wide constant would send one of them
    // to the wrong module.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
    });
    expect(payload.task_type).toBe('tts');
  });

  it('sends audio for a model out of the audio bucket', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('some-sfx', 'audio'),
    });
    expect(payload.task_type).toBe('audio');
  });

  it('carries the model id, not the bucket', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('fish-s2-pro', 'tts'),
    });
    expect(payload.model).toBe('fish-s2-pro');
  });
});

describe('buildAudioTaskPayload — what reaches the vendor', () => {
  it('sends the model\'s own params alongside the lines to speak', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
      params: { voice_id: 'Alice', stability: 0.5 },
    });
    expect(payload.params).toEqual({
      voice_id: 'Alice',
      stability: 0.5,
      prompt: 'Good evening.',
    });
  });

  it('lets the typed lines win over a same-named catalog param', () => {
    // The catalog is untrusted collaborative-adjacent config; what the user
    // typed must never be silently replaced by it.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
      params: { prompt: 'from the catalog' },
    });
    expect(payload.params.prompt).toBe('Good evening.');
  });

  it('overwrites the node it was launched from, fenced by its lease', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
      leaseGen: 4,
    });
    expect(payload.mode).toBe('overwrite');
    expect(payload.target_node_id).toBe('n1');
    expect(payload.node_gens).toEqual({ n1: 5 });
  });
});
