// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What pressing Generate does once a panel's view model is built from the
 * node as it is now: the execute gate's verdict, the words the panel shows for
 * a refusal, or the task it sends. The browser's three panels and the MCP
 * service (breatic#1488 §9) both run a node through these, so a refusal and a
 * request body never differ between a user's click and an agent's call.
 *
 * Building the view model and writing the prompt out stay with the caller:
 * the browser writes the prompt from its editor, the MCP service from the
 * pieces collab reads off the node, both with the view model's mention words.
 */

import { extractPromptText } from '@shared/agent/extract-prompt.js';
import { wireParams } from '@shared/canvas/dialogue.js';
import { AUDIO_SLOTS, audioMissing, audioSlotsForModel, type AudioSlot } from '@shared/canvas/model/audio-slots.js';
import { buildAudioTaskPayload } from '@shared/canvas/model/audio-task-payload.js';
import { type AudioPanelViewModel } from '@shared/canvas/model/generation/audio-panel-view-model.js';
import { type GeneratePanelViewModel } from '@shared/canvas/model/generation/panel-view-model.js';
import { type StoryboardRun } from '@shared/canvas/model/generation/storyboard-run.js';
import { type VideoPanelViewModel } from '@shared/canvas/model/generation/video-panel-view-model.js';
import { IMAGE_SLOTS } from '@shared/canvas/model/image-slots.js';
import { poolCounts, poolKindOf, poolParams } from '@shared/canvas/model/reference-urls.js';
import { slotRefusalKey } from '@shared/canvas/model/slots.js';
import { buildGenerateTaskPayload } from '@shared/canvas/model/task-payload.js';
import { VIDEO_SLOTS, videoMissing } from '@shared/canvas/model/video-slots.js';
import { buildVideoTaskPayload } from '@shared/canvas/model/video-task-payload.js';
import { evaluateExecute, refusalToastKey, type ExecuteGateInput, type ExecuteVerdict } from '@shared/generate-guards.js';
import { checkParamCombination } from '@shared/param-resolution.js';
import { type TaskCreateInput } from '@shared/schemas/api.js';
import { type ModelEntry } from '@shared/types/model-catalog.js';

/**
 * The words a refusal shows: the gate's own sentence, or a catalog key with
 * the values its message takes. `paramNameKey` names the setting a too-short
 * refusal is about; the caller writes its label in as `name`.
 */
export type RunRefusalText =
  | { readonly message: string }
  | { readonly key: string; readonly values: Readonly<Record<string, string | number>>; readonly paramNameKey?: string };

/** What pressing Generate does. */
export type RunPlan =
  | { readonly kind: 'refused'; readonly verdict: ExecuteVerdict; readonly text: RunRefusalText | null }
  | { readonly kind: 'ready'; readonly payload: TaskCreateInput };

/** The node a run is for. */
interface RunTarget {
  nodeId: string;
  projectId: string;
  spaceId: string;
}

/** What every panel's gate is also told. */
interface RunCommon extends RunTarget {
  /** The prompt written out with the view model's mention words; read only when the model takes one. */
  promptOf: () => string;
  /** The last refusal the server gave this input, when the panel knows one. */
  inputRefusal?: ExecuteGateInput['inputRefusal'];
}

/**
 * A refusal answered with the gate's own sentence, when it gave one.
 * @param verdict - The verdict.
 * @returns The sentence, or undefined.
 */
function messageOf(verdict: ExecuteVerdict): RunRefusalText | undefined {
  return verdict.message === undefined ? undefined : { message: verdict.message };
}

/**
 * The image panel's run.
 * @param input - The view model, the prompt and the node.
 * @returns The verdict or the task.
 */
export function planImageRun(input: RunCommon & { vm: GeneratePanelViewModel }): RunPlan {
  const { vm } = input;
  const promptText = vm.promptRequired ? input.promptOf() : '';
  const maxInputChars = vm.maxInputChars;
  const verdict = evaluateExecute({
    promptText,
    model: vm.model,
    nodeExists: vm.nodeExists,
    isSubmitting: false,
    promptRequired: vm.promptRequired,
    maxInputChars,
    missing: vm.missing,
    pools: poolCounts(vm.pool, vm.referenceUrls),
    inputRefusal: input.inputRefusal,
  });
  if (verdict !== null) {
    const text = messageOf(verdict) ?? imageRefusalText(verdict, vm, maxInputChars);
    return { kind: 'refused', verdict, text };
  }
  return {
    kind: 'ready',
    payload: buildGenerateTaskPayload({
      nodeId: input.nodeId,
      projectId: input.projectId,
      spaceId: input.spaceId,
      model: vm.model,
      params: vm.params,
      generation: { mode: vm.mode, declared: vm.modelEntry?.params ?? {} },
      promptText,
      poolParams: poolParams(vm.pool, vm.referenceUrls),
    }),
  };
}

/**
 * The image panel's words for a refusal; a refusal the style slot answers for speaks in its words (inner#826).
 * @param verdict - The verdict.
 * @param vm - The view model it judged.
 * @param maxInputChars - The model's input cap the gate judged by.
 * @returns The words, or null when the refusal says nothing.
 */
function imageRefusalText(verdict: ExecuteVerdict, vm: GeneratePanelViewModel, maxInputChars: number | undefined): RunRefusalText | null {
  if (verdict.refusal === 'too-many-references' && verdict.over) {
    return { key: 'canvas.generatePanel.errorTooManyReferences', values: verdict.over };
  }
  const key =
    verdict.slot === IMAGE_SLOTS.style.param
      ? slotRefusalKey(IMAGE_SLOTS, vm.slots, verdict)
      : poolKindOf(vm.pool, verdict.slot) !== undefined
        ? 'canvas.generatePanel.errorNoSourceImage'
        : refusalToastKey(verdict.refusal);
  return key === null ? null : { key, values: { max: maxInputChars ?? 0 } };
}

/**
 * The video panel's run.
 * @param input - The view model, the shots' part of the run, the prompt and the node.
 * @returns The verdict or the task.
 */
export function planVideoRun(input: RunCommon & { vm: VideoPanelViewModel; run: StoryboardRun }): RunPlan {
  const { vm, run } = input;
  // In the multi-shot mode the prompt is the shots written out, for a model
  // with no field for them, and nothing for one that has a field.
  const promptText = !vm.promptRequired ? '' : run.sendsPrompt ? input.promptOf() : (run.writtenPrompt ?? '');
  const maxInputChars = vm.modelEntry?.max_input_chars;
  const verdict = evaluateExecute({
    promptText,
    model: vm.model,
    nodeExists: vm.nodeExists,
    isSubmitting: false,
    promptRequired: vm.promptRequired,
    maxInputChars,
    missing: videoMissing(vm.modelEntry, vm.mode, vm.slots, vm.slotUrls, vm.referenceUrls),
    pools: poolCounts(vm.pool, vm.referenceUrls),
    storyboard: run.gate,
    inputRefusal: input.inputRefusal,
  });
  if (verdict !== null) {
    const text = messageOf(verdict) ?? videoRefusalText(verdict, vm, maxInputChars);
    return { kind: 'refused', verdict, text };
  }
  return {
    kind: 'ready',
    payload: buildVideoTaskPayload({
      nodeId: input.nodeId,
      projectId: input.projectId,
      spaceId: input.spaceId,
      model: vm.model,
      params: vm.params,
      generation: { mode: vm.mode, declared: vm.modelEntry?.params ?? {} },
      promptText: run.sendsPrompt || run.writtenPrompt !== undefined ? promptText : undefined,
      storyboardParams: run.params,
      // The payload's source fields are built FROM the drawn slots, so a pick
      // left behind by a mode or model switch has no way in.
      slots: vm.slots,
      slotUrls: vm.slotUrls,
      poolParams: poolParams(vm.pool, vm.referenceUrls),
    }),
  };
}

/**
 * The video panel's words for a refusal, naming the slot the panel calls a
 * first frame or a driving video where the gate knows only that it is empty.
 * @param verdict - The verdict.
 * @param vm - The view model it judged.
 * @param maxInputChars - The model's input cap the gate judged by.
 * @returns The words, or null when the refusal says nothing.
 */
function videoRefusalText(verdict: ExecuteVerdict, vm: VideoPanelViewModel, maxInputChars: number | undefined): RunRefusalText | null {
  if (verdict.refusal === 'too-many-references' && verdict.over) {
    return { key: 'canvas.generatePanel.errorTooManyReferences', values: verdict.over };
  }
  // An empty pool param, or a group any member of which would do: every video
  // model's group is the kinds its pool takes (the Reference to Video ones).
  const key =
    poolKindOf(vm.pool, verdict.slot) !== undefined || verdict.refusal === 'sources-missing'
      ? 'canvas.generatePanel.errorNoReferenceMention'
      : slotRefusalKey(VIDEO_SLOTS, vm.slots, verdict);
  if (key === null) return null;
  return {
    key,
    values: {
      max: maxInputChars ?? 0,
      kind: poolKindOf(vm.pool, verdict.slot) ?? 'other',
      // The storyboard refusals name the shot, the cap or the seconds.
      shot: verdict.shot ?? 0,
      limit: verdict.limit ?? 0,
      shots: verdict.seconds?.shots ?? 0,
      total: verdict.seconds?.total ?? 0,
    },
  };
}

/**
 * The text setting a model takes that is written too short, as the gate reads it.
 * @param model - The model.
 * @param params - The params the run sends.
 * @returns The gate's input: the setting, or nothing when every one is long enough.
 */
export function paramTooShort(model: ModelEntry | undefined, params: Readonly<Record<string, unknown>>): { paramTooShort?: string } {
  if (model === undefined) return {};
  const short = checkParamCombination(model, wireParams(model, params)).find((violation) => violation.rule === 'min_length');
  return short === undefined ? {} : { paramTooShort: short.param };
}

/**
 * The audio panel's run.
 * @param input - The view model, the mode it was built for, its slots, whether
 *   the mode collects lyrics, the prompt and lyrics, and the node.
 * @returns The verdict or the task.
 */
export function planAudioRun(
  input: RunCommon & { vm: AudioPanelViewModel; mode: string; slots: readonly AudioSlot[]; lyrics: boolean; lyricsOf: () => string },
): RunPlan {
  const { vm, mode } = input;
  const promptText = vm.promptRequired ? input.promptOf() : '';
  const lyricsText = input.lyrics ? input.lyricsOf() : undefined;
  const maxInputChars = vm.modelEntry?.max_input_chars;
  const verdict = evaluateExecute({
    promptText,
    model: vm.model,
    nodeExists: vm.nodeExists,
    isSubmitting: false,
    promptRequired: vm.promptRequired,
    maxInputChars,
    voiceRequired: vm.voiceRequired,
    voiceChosen: vm.voiceChosen,
    speakersShort: vm.speakersShort,
    linesEmpty: vm.dialogueNames !== null && extractPromptText(promptText).length === 0,
    ...paramTooShort(vm.modelEntry, vm.params),
    missing: audioMissing(vm.modelEntry, mode, vm.slotUrls, vm.params),
    lyricsRequired: input.lyrics,
    lyricsText,
    inputRefusal: input.inputRefusal,
  });
  if (verdict !== null) {
    const text = messageOf(verdict) ?? audioRefusalText(verdict, vm, mode, maxInputChars);
    return { kind: 'refused', verdict, text };
  }
  const modelEntry = vm.modelEntry;
  // Unreachable past the gate above, which answers `no-model`; stated so the
  // payload builder gets an entry rather than undefined.
  if (!modelEntry) return { kind: 'refused', verdict: { refusal: 'no-model' }, text: null };
  return {
    kind: 'ready',
    payload: buildAudioTaskPayload({
      nodeId: input.nodeId,
      projectId: input.projectId,
      spaceId: input.spaceId,
      model: modelEntry,
      params: vm.params,
      generation: { mode, declared: modelEntry.params },
      promptText,
      // Read off the same view model the gate judged, so the payload can only
      // ever carry the pick that passed it.
      slotUrls: vm.slotUrls,
      // The mode's own slots, so a pick made for the other mode cannot ride
      // this run: a pick survives a mode switch by design.
      slots: input.slots,
      // Only on a mode that collects them; absent leaves the field out.
      ...(lyricsText === undefined ? {} : { lyricsText }),
    }),
  };
}

/**
 * The audio panel's words for a refusal.
 * @param verdict - The verdict.
 * @param vm - The view model it judged.
 * @param mode - The mode it was built for.
 * @param maxInputChars - The model's input cap the gate judged by.
 * @returns The words, or null when the refusal says nothing.
 */
function audioRefusalText(verdict: ExecuteVerdict, vm: AudioPanelViewModel, mode: string, maxInputChars: number | undefined): RunRefusalText | null {
  const key = slotRefusalKey(AUDIO_SLOTS, audioSlotsForModel(vm.modelEntry, mode, vm.params), verdict);
  if (key === null) return null;
  return {
    key,
    values: { max: maxInputChars ?? 0 },
    ...(verdict.param === undefined ? {} : { paramNameKey: `canvas.generatePanel.param.${verdict.param}` }),
  };
}
