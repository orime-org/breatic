// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a node's panel would run right now: the mode, model and params in
 * effect, resolved by the same rules the panels resolve by.
 *
 * The node stores choices that can be stale — a mode this deployment no longer
 * serves, a model picked under another mode, a param set in another mode. The
 * attach snapshot hands the agent both the stored data and this
 * answer, so it can tell what is written from what would actually run.
 */

import { wireParams } from '@shared/canvas/dialogue.js';
import { AUDIO_MODE_OPTIONS } from '@shared/canvas/model/audio-mode-options.js';
import { buildAudioPanelViewModel, withListDefaultVoice } from '@shared/canvas/model/generation/audio-panel-view-model.js';
import { IMAGE_MODE_OPTIONS } from '@shared/canvas/model/generation/image-mode-selection.js';
import { modelsForModality } from '@shared/canvas/model/generation/modality-buckets.js';
import { filterAvailableModes, filterModelsByMode, pickModelForMode, resolveAvailableMode } from '@shared/canvas/model/generation/mode-selection.js';
import { withStyleImages } from '@shared/canvas/model/generation/style-picks.js';
import { resolveModelSwitch } from '@shared/canvas/model/model-params.js';
import { type ContentNodeView } from '@shared/canvas/model/node-view.js';
import { VIDEO_MODE_OPTIONS } from '@shared/canvas/model/video-mode-options.js';
import { paramsForMode } from '@shared/param-modes.js';
import { type GenerationNodeType, type ModelCatalog, type ModelEntry } from '@shared/types/model-catalog.js';

/** The generation a node would run if its panel's Generate were pressed now. */
export interface CurrentGeneration {
  readonly mode: string;
  readonly model: string;
  readonly params: Record<string, unknown>;
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
 * @param firstVoiceOf - The first voice of a model's list, which the audio
 *   panel sends when nobody picked one; undefined when it is not known.
 * @returns The generation in effect, or null when the catalog is missing or
 *   serves nothing for this type.
 */
export function currentGeneration(
  kind: GenerationNodeType,
  content: ContentNodeView,
  catalog: ModelCatalog | undefined,
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
    // stay behind, and so do params declared for other modes.
    params: paramsForMode(
      wireParams(
        entry,
        kind === 'audio'
          ? audioParams(content, models, mode, firstVoiceOf)
          // The image and video panels send the style images the model takes.
          : withStyleImages(entry, mode, content.styleImageUrls, resolveModelSwitch(content, entry).params).params,
      ),
      entry.params,
      mode,
    ),
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
  const vm = buildAudioPanelViewModel({ nodeId: '', nodes: [{ id: '', type: 'audio', data: content }], models, mode });
  // Asked for only where the panel asks for it.
  const first = vm.voiceRequired && !vm.voiceChosen ? firstVoiceOf(vm.model) : undefined;
  return withListDefaultVoice(vm, first).params;
}
