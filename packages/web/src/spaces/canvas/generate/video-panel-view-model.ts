// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure derivation of the video Generate panel's render inputs from a node's
 * live Yjs data + the model catalog (#1896). Kept out of the container so the
 * model narrowing, the default pick and param reconciliation are all testable
 * without React / Yjs / react-query.
 *
 * A sibling of the image panel's view model rather than a shared one: the two
 * panels offer different modes and different params (user 2026-08-08). What IS
 * shared sits one level down — the mode filter, the param reconciler and the
 * param value reader all serve both.
 */

import { isVideoGenerationMode, VIDEO_GENERATION_MODES } from '@breatic/shared';
import type { ModelEntry } from '@breatic/shared';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { filterModelsByMode } from '@web/spaces/canvas/generate/mode-selection';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import type {
  ContentNodeView,
  NodeView,
} from '@web/spaces/canvas/types/node-view';

/**
 * The generation modes the video panel offers — the six the user decided
 * belong here (2026-08-08); the other four video modes (extend / edit /
 * motion-control / upscale / interpolate) belong to the mini-tool system.
 * Derived from the shared list so the panel and the catalog classifier can
 * never disagree on what counts as generation.
 */
export type VideoGenMode = (typeof VIDEO_GENERATION_MODES)[number];

/** The render inputs the video Generate panel needs, derived from live node data. */
export interface VideoPanelViewModel {
  /** Catalog video models offered by the picker under the active mode. */
  models: ModelEntry[];
  /** Effective model id (stored, else the first offered). Empty when the mode offers none. */
  model: string;
  /** Effective params, reconciled against the current model. */
  params: Record<string, unknown>;
  /** Credit cost of one generation with the current model. */
  creditEstimate: number;
  /** The target node's display status — gates execute (no submit while handling). */
  nodeStatus: string | undefined;
  /**
   * Whether the GLOBAL generatable-video catalog is empty (still loading,
   * failed to load, or nothing configured). Distinct from `models.length`,
   * which is the ACTIVE-mode subset: a mode with no model must not read as a
   * broken catalog, or the mode control would disable itself out of the only
   * mode the user can get back from.
   */
  catalogEmpty: boolean;
}

/**
 * Narrows a node view to a content view (the only kind carrying generate
 * inputs). `status` is a required field on every content view and absent on
 * annotation / group, so it is a reliable runtime discriminant.
 * @param data - The node view to narrow.
 * @returns The content view, or undefined for annotation / group / missing.
 */
function asContentView(data: NodeView | undefined): ContentNodeView | undefined {
  return data && 'status' in data ? data : undefined;
}

/**
 * Narrows the sanitized video catalog to the models offered under a panel mode.
 *
 * Two narrowings, both required. First drop the non-generation entries — video
 * upscaling, frame interpolation, extension, editing and motion control all
 * ship in `catalog.video` but belong to the mini-tool system; offering them
 * here would put "Video Upscale Pro" in the text-to-video picker and the submit
 * would be refused by the backend source gate. Then narrow to the active mode
 * so the picker shows one clean list.
 *
 * Exported so the container can memoize the SAME selection on [models, mode]
 * alone — the view model rebuilds on every canvas graph mutation, and a freshly
 * filtered array each time would defeat the React.memo on the pickers.
 * @param models - The sanitized catalog video models.
 * @param mode - The active generation mode.
 * @returns The models offered under that mode.
 */
export function selectVideoModeModels(
  models: ModelEntry[],
  mode: VideoGenMode,
): ModelEntry[] {
  return filterModelsByMode(models.filter((m) => isVideoGenerationMode(m.mode)), mode);
}

/**
 * Derives the video Generate panel's render inputs from a node's live data.
 * @param input - The target node id, current nodes, catalog models and mode.
 * @param input.nodeId - The node whose panel is open.
 * @param input.nodes - Current canvas node views.
 * @param input.models - Catalog video models (the `video` bucket, unfiltered).
 * @param input.mode - The active generation mode. Passed in rather than read off
 *   the node: the panel owns which mode it is showing, and the node stores one
 *   `mode` field shared with the image panel's own mode set.
 * @returns The derived view model.
 */
export function buildVideoPanelViewModel(input: {
  nodeId: string;
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  models: ModelEntry[];
  mode: VideoGenMode;
}): VideoPanelViewModel {
  const { nodeId, nodes, mode } = input;
  const content = asContentView(nodes.find((n) => n.id === nodeId)?.data);

  // Kept separate from `models`: the wide filter answers "is there any video
  // model at all", the narrow one answers "what does this mode offer".
  const generatable = input.models.filter((m) => isVideoGenerationMode(m.mode));
  const models = filterModelsByMode(generatable, mode);

  // The stored model wins only while this mode still offers it. A stale pick
  // (another mode's, or one dropped from the catalog) falls back to the first
  // offered model — submitting a model the mode does not offer would be
  // refused by the backend source gate.
  const stored = content?.model;
  const model =
    stored && models.some((m) => m.name === stored)
      ? stored
      : (models[0]?.name ?? '');
  const current = models.find((m) => m.name === model);

  return {
    models,
    model,
    params: current ? resolveParamsForModel(current, content?.params ?? {}) : {},
    // `?? 0` covers only the model-not-found case (empty catalog / stale
    // model); when current is found, cost_per_call is a trusted number.
    creditEstimate: current?.cost_per_call ?? 0,
    nodeStatus: content?.status,
    catalogEmpty: generatable.length === 0,
  };
}
