// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import { buildAudioPanelViewModel } from '@web/spaces/canvas/generate/audio-panel-view-model';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';

/**
 * A tts model.
 * @param name - Model id.
 * @param overrides - Fields this case cares about.
 * @returns A model entry.
 */
function ttsModel(name: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name,
    display_name: name,
    modality: 'tts',
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 10,
    generation_time: 30,
    takes_prompt: true,
    params: {},
    providers: [],
    sourcesByMode: {},
    ...overrides,
  };
}

const ELEVEN = ttsModel('elevenlabs-v3', {
  params: {
    voice_id: { description: '', default: 'Alice', remote_source: 'voices' },
    stability: { description: '', values: [0, 0.5, 1], default: 0.5 },
  },
  rate: { credits: 10, per: 1000, unit: 'characters' },
});
const FISH = ttsModel('fish-s2-pro', {
  params: {
    reference_id: { description: '', default: null, remote_source: 'voices' },
    speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
  },
});

/**
 * One audio node carrying the given data.
 * @param data - The node's data fields.
 * @returns A one-node list.
 */
function nodes(
  data: Record<string, unknown> = {},
): ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>> {
  return [
    {
      id: 'n1',
      // `status` is what marks a node view as a CONTENT one; a fixture without
      // it reads as a node that carries no model, no params and no voice.
      data: { kind: 'audio', status: 'idle', ...data } as CanvasNodeView['data'],
    },
  ];
}

const BASE = {
  nodeId: 'n1',
  models: [ELEVEN, FISH],
  mode: 'tts',
  edges: [],
  textById: new Map<string, string>(),
};

describe('buildAudioPanelViewModel — which model the panel is on', () => {
  it('takes the model stored on the node', () => {
    const vm = buildAudioPanelViewModel({
      ...BASE,
      nodes: nodes({ model: 'fish-s2-pro' }),
    });
    expect(vm.model).toBe('fish-s2-pro');
    expect(vm.modelEntry?.name).toBe('fish-s2-pro');
  });

  it('falls back to the first offered model when the node holds none', () => {
    const vm = buildAudioPanelViewModel({ ...BASE, nodes: nodes() });
    expect(vm.model).toBe('elevenlabs-v3');
  });

  it('falls back when the stored model is not one this mode offers', () => {
    // A model dropped from the catalog, or picked under another mode.
    const vm = buildAudioPanelViewModel({
      ...BASE,
      nodes: nodes({ model: 'a-model-that-left' }),
    });
    expect(vm.model).toBe('elevenlabs-v3');
  });

  it('carries the rate of the model it landed on', () => {
    const vm = buildAudioPanelViewModel({ ...BASE, nodes: nodes() });
    expect(vm.modelEntry?.rate).toEqual({
      credits: 10,
      per: 1000,
      unit: 'characters',
    });
  });

  it('offers nothing from a mode this panel is not on', () => {
    // This panel reads two catalog buckets, and the audio one holds sound
    // effect and music models whose mode is not voiceover. Picking one here
    // would generate something else entirely.
    const SFX = ttsModel('a-sfx-model', { modality: 'audio', mode: 'sfx' });
    const vm = buildAudioPanelViewModel({
      ...BASE,
      models: [SFX, ELEVEN],
      nodes: nodes({ model: 'a-sfx-model' }),
    });
    expect(vm.model).toBe('elevenlabs-v3');
  });

  it('has no model entry when the mode offers none', () => {
    const vm = buildAudioPanelViewModel({ ...BASE, models: [], nodes: nodes() });
    expect(vm.model).toBe('');
    expect(vm.modelEntry).toBeUndefined();
  });
});

describe('buildAudioPanelViewModel — params come from the model\'s own record', () => {
  it('reads the record kept for this model', () => {
    const vm = buildAudioPanelViewModel({
      ...BASE,
      nodes: nodes({
        model: 'elevenlabs-v3',
        paramsByModel: { 'elevenlabs-v3': { stability: 1 } },
      }),
    });
    expect(vm.params.stability).toBe(1);
  });

  it('ignores another model\'s record', () => {
    // Each model reads only its own; there is no path between the two records,
    // so a voice picked for one can never be submitted with the other.
    const vm = buildAudioPanelViewModel({
      ...BASE,
      nodes: nodes({
        model: 'fish-s2-pro',
        paramsByModel: { 'elevenlabs-v3': { stability: 1 } },
      }),
    });
    expect(vm.params.stability).toBeUndefined();
  });
});

describe('buildAudioPanelViewModel — whether a voice has been chosen', () => {
  it('says no voice is chosen when the record holds none', () => {
    // Reading the RECORD, not the resolved value: resolving falls back to the
    // yaml default, and `Alice` is a name this deployment may not accept.
    const vm = buildAudioPanelViewModel({ ...BASE, nodes: nodes() });
    expect(vm.voiceRequired).toBe(true);
    expect(vm.voiceChosen).toBe(false);
  });

  it('says a voice is chosen once the record holds one', () => {
    const vm = buildAudioPanelViewModel({
      ...BASE,
      nodes: nodes({
        model: 'elevenlabs-v3',
        paramsByModel: { 'elevenlabs-v3': { voice_id: 'Aria' } },
      }),
    });
    expect(vm.voiceChosen).toBe(true);
    expect(vm.voiceSelectedId).toBe('Aria');
  });

  it('finds the voice param under each vendor\'s own name', () => {
    // ElevenLabs takes `voice_id`, Fish takes `reference_id`; the panel finds
    // it by the catalog's `remote_source` marker.
    const vm = buildAudioPanelViewModel({
      ...BASE,
      nodes: nodes({
        model: 'fish-s2-pro',
        paramsByModel: { 'fish-s2-pro': { reference_id: 'uuid-1' } },
      }),
    });
    expect(vm.voiceChosen).toBe(true);
    expect(vm.voiceSelectedId).toBe('uuid-1');
  });

  it('needs no voice from a model that declares none', () => {
    const vm = buildAudioPanelViewModel({
      ...BASE,
      models: [ttsModel('no-voice')],
      nodes: nodes(),
    });
    expect(vm.voiceRequired).toBe(false);
    expect(vm.voiceSelectedId).toBeNull();
  });
});

describe('buildAudioPanelViewModel — what execute needs to know', () => {
  it('reports the node status the execute gate reads', () => {
    const vm = buildAudioPanelViewModel({
      ...BASE,
      nodes: nodes({ status: 'handling' }),
    });
    expect(vm.nodeStatus).toBe('handling');
  });

  it('says the prompt is required for a model that consumes one', () => {
    const vm = buildAudioPanelViewModel({ ...BASE, nodes: nodes() });
    expect(vm.promptRequired).toBe(true);
  });

  it('says it is not for a model that consumes none', () => {
    const vm = buildAudioPanelViewModel({
      ...BASE,
      models: [ttsModel('silent', { takes_prompt: false })],
      nodes: nodes(),
    });
    expect(vm.promptRequired).toBe(false);
  });
});
