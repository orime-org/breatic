// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a node's panel would run right now (#2218): the mode, model, params and
 * storyboard tier in effect, resolved by the same rules the panels resolve by.
 *
 * The node stores choices that can be stale — a mode this deployment no longer
 * serves, a model picked under another mode, a storyboard tier on a model that
 * takes none. The attach snapshot hands the agent both the stored data and this
 * answer, so it can tell what is written from what would actually run.
 */

import {
  effectiveStoryboardKind,
  type GenerationNodeType,
  type ModelCatalog,
  type ModelEntry,
  type StoryboardKind,
} from '@breatic/shared';

import type { ContentNodeView } from '@web/data/yjs/node-view';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { buildAudioPanelViewModel, withListDefaultVoice } from '@web/spaces/canvas/generate/audio-panel-view-model';
import { IMAGE_MODE_OPTIONS } from '@web/spaces/canvas/generate/image-mode-selection';
import { modelsForModality } from '@web/spaces/canvas/generate/modality-buckets';
import { resolveModelSwitch } from '@web/spaces/canvas/generate/model-params';
import { wireParams } from '@web/spaces/canvas/generate/stand-in';
import {
  filterAvailableModes,
  filterModelsByMode,
  pickModelForMode,
  resolveAvailableMode,
} from '@web/spaces/canvas/generate/mode-selection';
import { VIDEO_MODE_OPTIONS } from '@web/spaces/canvas/generate/video-mode-options';

/** The generation a node would run if its panel's Generate were pressed now. */
export interface CurrentGeneration {
  readonly mode: string;
  readonly model: string;
  readonly params: Record<string, unknown>;
  readonly storyboard: StoryboardKind;
}

const MODE_OPTIONS: Readonly<Record<GenerationNodeType, readonly { value: string }[]>> = {
  image: IMAGE_MODE_OPTIONS,
  video: VIDEO_MODE_OPTIONS,
  audio: AUDIO_MODE_OPTIONS,
};

/**
 * Resolves what a node would run right now.
 * @param kind - The node's generating type.
 * @param content - The node's content view.
 * @param catalog - The model catalog, or undefined before it arrives.
 * @param storyboardKindOf - Reads the tier stored for a mode.
 * @param firstVoiceOf - The first voice of a model's list, which the audio
 *   panel sends when nobody picked one; undefined when it is not known.
 * @returns The generation in effect, or null when the catalog is missing or
 *   serves nothing for this type.
 */
export function currentGeneration(
  kind: GenerationNodeType,
  content: ContentNodeView,
  catalog: ModelCatalog | undefined,
  storyboardKindOf: (mode: string) => StoryboardKind | undefined,
  firstVoiceOf: (model: string) => { id: string } | null | undefined,
): CurrentGeneration | null {
  const models = modelsForModality(catalog, kind);
  const mode = resolveAvailableMode(content.mode, filterAvailableModes(MODE_OPTIONS[kind], models));
  if (!mode) return null;
  const modeModels = filterModelsByMode(models, mode);
  const name = pickModelForMode(content.model, mode, content.modelByMode, modeModels);
  const entry = modeModels.find((m) => m.name === name);
  if (!entry) return null;
  return {
    mode,
    model: entry.name,
    // As the run sends them: the side of a stand-in not in use and its switch
    // stay behind.
    params: wireParams(
      entry,
      kind === 'audio' ? audioParams(content, models, mode, firstVoiceOf) : resolveModelSwitch(content, entry).params,
    ),
    storyboard: effectiveStoryboardKind(entry.params, storyboardKindOf(mode)),
  };
}

/**
 * The audio panel's params: the node's own, plus the list's first voice where
 * nobody picked one, by the panel's own two steps.
 * @param content - The node's content view.
 * @param models - The audio models on offer.
 * @param mode - The mode in effect.
 * @param firstVoiceOf - The first voice of a model's list.
 * @returns The params.
 */
function audioParams(
  content: ContentNodeView,
  models: ModelEntry[],
  mode: string,
  firstVoiceOf: (model: string) => { id: string } | null | undefined,
): Record<string, unknown> {
  const vm = buildAudioPanelViewModel({ nodeId: '', nodes: [{ id: '', data: content }], models, mode });
  // Asked for only where the panel asks for it.
  const first = vm.voiceRequired && !vm.voiceChosen ? firstVoiceOf(vm.model) : undefined;
  return withListDefaultVoice(vm, first).params;
}
