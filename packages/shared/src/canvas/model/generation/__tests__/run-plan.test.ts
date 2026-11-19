// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { buildAudioTaskPayload } from '@shared/canvas/model/audio-task-payload.js';
import { type AudioPanelViewModel } from '@shared/canvas/model/generation/audio-panel-view-model.js';
import { type GeneratePanelViewModel } from '@shared/canvas/model/generation/panel-view-model.js';
import { planAudioRun, planImageRun, planVideoRun } from '@shared/canvas/model/generation/run-plan.js';
import { type StoryboardRun } from '@shared/canvas/model/generation/storyboard-run.js';
import { type VideoPanelViewModel } from '@shared/canvas/model/generation/video-panel-view-model.js';
import { buildGenerateTaskPayload } from '@shared/canvas/model/task-payload.js';
import { buildVideoTaskPayload } from '@shared/canvas/model/video-task-payload.js';
import { type ModelEntry } from '@shared/types/model-catalog.js';

const WHERE = { nodeId: 'n1', projectId: '00000000-0000-4000-8000-000000000001', spaceId: '00000000-0000-4000-8000-000000000002' };

/**
 * A model entry with only what the plans read.
 * @param over - Fields to set.
 * @returns The entry.
 */
function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return { name: 'm', modality: 'image', mode: 't2i', params: {}, ...over } as ModelEntry;
}

/**
 * An image panel's view model with only what the plan reads.
 * @param over - Fields to set.
 * @returns The view model.
 */
function imageVm(over: Partial<GeneratePanelViewModel> = {}): GeneratePanelViewModel {
  return {
    model: 'm',
    modelEntry: entry(),
    params: { size: '1k' },
    mode: 't2i',
    nodeExists: true,
    promptRequired: true,
    missing: [],
    pool: {},
    referenceUrls: {},
    slots: [],
    mentionTokens: {},
    ...over,
  } as unknown as GeneratePanelViewModel;
}

describe('planImageRun', () => {
  it('builds the task the panel sends, with the prompt serialized at run time', () => {
    const vm = imageVm();
    const plan = planImageRun({ ...WHERE, vm, promptOf: () => 'a red fox' });
    expect(plan).toEqual({
      kind: 'ready',
      payload: buildGenerateTaskPayload({
        ...WHERE,
        model: 'm',
        params: { size: '1k' },
        generation: { mode: 't2i', declared: {} },
        promptText: 'a red fox',
        poolParams: {},
      }),
    });
  });

  it('reads no prompt for a model that takes none', () => {
    const promptOf = vi.fn(() => 'stale words');
    const plan = planImageRun({ ...WHERE, vm: imageVm({ promptRequired: false }), promptOf });
    expect(promptOf).not.toHaveBeenCalled();
    expect(plan.kind).toBe('ready');
  });

  it('refuses an empty prompt with the words the panel shows', () => {
    const plan = planImageRun({ ...WHERE, vm: imageVm(), promptOf: () => '   ' });
    expect(plan).toMatchObject({ kind: 'refused', verdict: { refusal: 'prompt-missing' } });
    expect(plan.kind === 'refused' && plan.text !== null && 'key' in plan.text).toBe(true);
  });

  it('refuses a node that is gone', () => {
    expect(planImageRun({ ...WHERE, vm: imageVm({ nodeExists: false }), promptOf: () => 'x' })).toMatchObject({
      kind: 'refused',
      verdict: { refusal: 'node-gone' },
    });
  });
});

/**
 * A video panel's view model with only what the plan reads.
 * @param over - Fields to set.
 * @returns The view model.
 */
function videoVm(over: Partial<VideoPanelViewModel> = {}): VideoPanelViewModel {
  return {
    model: 'v',
    modelEntry: entry({ name: 'v', modality: 'video', mode: 't2v' }),
    params: { duration: 5 },
    mode: 't2v',
    nodeExists: true,
    promptRequired: true,
    pool: {},
    referenceUrls: {},
    slots: [],
    slotUrls: {},
    mentionTokens: {},
    ...over,
  } as unknown as VideoPanelViewModel;
}

const NO_SHOTS: StoryboardRun = { sendsPrompt: true, writtenPrompt: undefined, params: {}, gate: undefined };

describe('planVideoRun', () => {
  it('sends the main prompt outside the multi-shot mode', () => {
    const plan = planVideoRun({ ...WHERE, vm: videoVm(), run: NO_SHOTS, promptOf: () => 'waves' });
    expect(plan).toEqual({
      kind: 'ready',
      payload: buildVideoTaskPayload({
        ...WHERE,
        model: 'v',
        params: { duration: 5 },
        generation: { mode: 't2v', declared: {} },
        promptText: 'waves',
        storyboardParams: {},
        slots: [],
        slotUrls: {},
        poolParams: {},
      }),
    });
  });

  it('sends the shots written out in place of the main prompt, which it never reads', () => {
    const promptOf = vi.fn(() => 'main prompt');
    const run: StoryboardRun = { sendsPrompt: false, writtenPrompt: 'Shot 1: a; Shot 2: b', params: {}, gate: undefined };
    const plan = planVideoRun({ ...WHERE, vm: videoVm(), run, promptOf });
    expect(promptOf).not.toHaveBeenCalled();
    expect(plan.kind === 'ready' && (plan.payload.params as { prompt?: unknown }).prompt).toBe('Shot 1: a; Shot 2: b');
  });
});

/**
 * An audio panel's view model with only what the plan reads.
 * @param over - Fields to set.
 * @returns The view model.
 */
function audioVm(over: Partial<AudioPanelViewModel> = {}): AudioPanelViewModel {
  return {
    model: 'a',
    modelEntry: entry({ name: 'a', modality: 'tts', mode: 'tts' }),
    params: { voice_id: 'v1' },
    nodeExists: true,
    promptRequired: true,
    voiceRequired: true,
    voiceChosen: true,
    speakersShort: false,
    dialogueNames: null,
    slotUrls: {},
    ...over,
  } as unknown as AudioPanelViewModel;
}

describe('planAudioRun', () => {
  it('builds the task with the lyrics when the mode collects them', () => {
    const vm = audioVm();
    const plan = planAudioRun({ ...WHERE, vm, mode: 'tts', slots: [], lyrics: true, promptOf: () => 'hello', lyricsOf: () => 'la la' });
    expect(plan).toEqual({
      kind: 'ready',
      payload: buildAudioTaskPayload({
        ...WHERE,
        model: vm.modelEntry!,
        params: { voice_id: 'v1' },
        generation: { mode: 'tts', declared: {} },
        promptText: 'hello',
        slotUrls: {},
        slots: [],
        lyricsText: 'la la',
      }),
    });
  });

  it('refuses a voice nobody chose', () => {
    const plan = planAudioRun({ ...WHERE, vm: audioVm({ voiceChosen: false }), mode: 'tts', slots: [], lyrics: false, promptOf: () => 'hi', lyricsOf: () => '' });
    expect(plan).toMatchObject({ kind: 'refused', verdict: { refusal: 'voice-missing' } });
  });

  it('refuses with no words when there is no model', () => {
    expect(planAudioRun({ ...WHERE, vm: audioVm({ model: '', modelEntry: undefined }), mode: 'tts', slots: [], lyrics: false, promptOf: () => 'hi', lyricsOf: () => '' })).toMatchObject({
      kind: 'refused',
      verdict: { refusal: 'no-model' },
    });
  });
});
