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

import { VIDEO_GENERATION_MODES } from '@breatic/shared';
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
 * belong here (2026-08-08); the other five video modes (extend / edit /
 * motion-control / upscale / interpolate) belong to the mini-tool system.
 * Derived from the shared list so the panel and the catalog classifier can
 * never disagree on what counts as generation.
 */
export type VideoGenMode = (typeof VIDEO_GENERATION_MODES)[number];

/**
 * The render inputs the video Generate panel needs, derived from live node
 * data. Only what the panel actually renders: the model list it shows comes
 * from `selectVideoModeModels`, memoized separately by the container so a
 * canvas mutation cannot rebuild it and defeat the pickers' memo.
 */
export interface VideoPanelViewModel {
  /** Effective model id (stored, else the first offered). Empty when the mode offers none. */
  model: string;
  /** Effective params, reconciled against the current model. */
  params: Record<string, unknown>;
  /** Credit cost of one generation with the current model. */
  creditEstimate: number;
  /** The target node's display status — gates execute (no submit while handling). */
  nodeStatus: string | undefined;
  /**
   * Whether the active mode needs a source asset — read off the model's
   * precomputed `sourcesByMode` (backend-computed, on the wire), never
   * re-derived here. `t2v` is `[]`; `i2v` is `["image"]`. No model resolved
   * (empty catalog) means no gate: a requirement the user cannot satisfy is
   * worse than none, and the model gate already stops that submit.
   */
  requiresSource: boolean;
  /** The picked first-frame image (pick-time copy), or undefined when empty. */
  firstFrameUrl: string | undefined;
}

/**
 * The mode a video node's panel opens in.
 *
 * The node stores ONE `mode` field, shared with the image panel's own mode set
 * (a node can only ever be one modality, so they never collide in practice) —
 * but a value this panel does not offer must not be honoured: opening on `t2i`
 * or on a mini-tool video mode would narrow the model list to nothing and
 * leave the panel with no model to submit.
 * @param stored - The node's stored `mode`, if any.
 * @returns The stored mode when this panel offers it, else text-to-video.
 */
export function resolveVideoMode(stored: string | undefined): VideoGenMode {
  return VIDEO_GENERATION_MODES.includes(stored as VideoGenMode)
    ? (stored as VideoGenMode)
    : 't2v';
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
 * The video models the panel offers under one generation mode.
 *
 * `catalog.video` also ships the mini-tool entries — video upscaling, frame
 * interpolation, extension, editing, motion control — and offering one of
 * those here would put "Video Upscale Pro" in the text-to-video picker, where
 * a submit is then refused by the backend source gate. Narrowing to the mode
 * is by itself enough to keep them out: `mode` is one of the six generation
 * modes, and a mini-tool entry declares none of them. A separate
 * "is this generatable" pass would be dead weight — it can only remove models
 * the mode filter removes anyway (verified by exhausting every one- and
 * two-mode combination against every panel mode: 726 cases, zero differences).
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
  return filterModelsByMode(models, mode);
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

  const models = selectVideoModeModels(input.models, mode);

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
    model,
    params: current ? resolveParamsForModel(current, content?.params ?? {}) : {},
    // `?? 0` covers only the model-not-found case (empty catalog / stale
    // model); when current is found, cost_per_call is a trusted number.
    creditEstimate: current?.cost_per_call ?? 0,
    nodeStatus: content?.status,
    // Execute gate (#1675, cross-modality): the ACTIVE PANEL MODE decides what
    // the submission needs, and the model carries the answer precomputed. The
    // rule itself lives backend-side (domain/source-requirement.ts); the panel
    // only reads the wire field.
    requiresSource: current ? (current.sourcesByMode[mode]?.length ?? 0) > 0 : false,
    firstFrameUrl: content?.firstFrameUrl,
  };
}
