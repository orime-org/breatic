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
  type StoryboardKind,
} from '@breatic/shared';

import type { ContentNodeView } from '@web/data/yjs/node-view';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { IMAGE_MODE_OPTIONS } from '@web/spaces/canvas/generate/image-mode-selection';
import { modelsForModality } from '@web/spaces/canvas/generate/modality-buckets';
import { resolveModelSwitch } from '@web/spaces/canvas/generate/model-params';
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
 * @returns The generation in effect, or null when the catalog is missing or
 *   serves nothing for this type.
 */
export function currentGeneration(
  kind: GenerationNodeType,
  content: ContentNodeView,
  catalog: ModelCatalog | undefined,
  storyboardKindOf: (mode: string) => StoryboardKind | undefined,
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
    params: resolveModelSwitch(content, entry).params,
    storyboard: effectiveStoryboardKind(entry.params, storyboardKindOf(mode)),
  };
}
