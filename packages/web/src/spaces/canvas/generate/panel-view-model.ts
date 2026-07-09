// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure derivation of the Generate panel's render inputs from a node's live Yjs
 * data + the model catalog. Kept out of the container so the model-default
 * pick, param reconciliation, reference rail, and reference-URL snapshot are
 * all unit-testable without React / Yjs / react-query.
 */

import { isImageGenerationMode, type ModelEntry } from '@breatic/shared';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import {
  deriveReferences,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';
import {
  filterModelsByMode,
  resolveModelForMode,
  type ImageGenMode,
} from '@web/spaces/canvas/generate/image-mode-selection';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import type {
  ContentNodeView,
  NodeView,
} from '@web/spaces/canvas/types/node-view';

/** Default generation sub-mode for a node with none stored (design 2026-07-09 §2.3). */
const DEFAULT_IMAGE_GEN_MODE: ImageGenMode = 't2i';

/**
 * Reads a node's stored generation sub-mode, defaulting + boundary-sanitizing:
 * anything that is not the literal `'i2i'` (undefined, `'t2i'`, or a malformed
 * value from untrusted Yjs) resolves to the default `'t2i'`.
 * @param stored - The node's stored `mode` (free string on the wire).
 * @returns The active {@link ImageGenMode}.
 */
function resolveMode(stored: string | undefined): ImageGenMode {
  return stored === 'i2i' ? 'i2i' : DEFAULT_IMAGE_GEN_MODE;
}

/** The render inputs the Generate panel needs, derived from live node data. */
export interface GeneratePanelViewModel {
  /** Catalog image models offered by the picker. */
  models: ModelEntry[];
  /** Effective model id (stored, else the catalog default). */
  model: string;
  /** Effective params, reconciled against the current model. */
  params: Record<string, unknown>;
  /** Reference rail rows derived from incoming edges. */
  references: ReferenceRailItem[];
  /** Reference source asset URLs, snapshotted for the execute payload. */
  referenceUrls: string[];
  /** Credit cost of one generation with the current model. */
  creditEstimate: number;
  /** The target node's display status — gates execute (no submit while handling). */
  nodeStatus: string | undefined;
  /** Active generation sub-mode (the t2i / i2i toggle state; default t2i). */
  mode: ImageGenMode;
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
 * Reads a content node's primary asset URL when it carries one (the visual /
 * media modalities). Text content is a body, not a URL, so it is excluded.
 * @param data - The source node view.
 * @returns The asset URL, or undefined when the node has no URL payload.
 */
function assetUrlOf(data: NodeView | undefined): string | undefined {
  if (!data) return undefined;
  switch (data.kind) {
    case 'image':
    case 'audio':
    case 'video':
    case '3d':
    case 'web':
      return data.content;
    default:
      return undefined;
  }
}

/**
 * Picks the effective model id for the active mode: the node's stored model
 * when it is still offered under this mode, else the mode's remembered pick,
 * else the mode's `recommended` model, else the first model offered for the
 * mode (user 2026-07-09 — the recommended tier is a curation signal and drives
 * the default). Empty string when the mode offers no model.
 * @param stored - The node's stored model id (may be absent / stale / wrong-mode).
 * @param mode - The active generation sub-mode.
 * @param modelByMode - The node's per-mode model memory.
 * @param modeModels - The catalog models offered under the active mode.
 * @returns The effective model id, or empty string when the mode has no models.
 */
function pickModelForMode(
  stored: string | undefined,
  mode: ImageGenMode,
  modelByMode: Record<string, string> | undefined,
  modeModels: ModelEntry[],
): string {
  if (stored && modeModels.some((m) => m.name === stored)) return stored;
  return resolveModelForMode(mode, modelByMode ?? {}, modeModels) ?? '';
}

/**
 * Resolves the model + reconciled params to persist when TOGGLING a node to a
 * new generation mode. Mirrors {@link buildGeneratePanelViewModel}'s
 * model/params derivation but for an ARBITRARY target mode (not the node's
 * stored one), so the container can compute what `setNodeMode` should write.
 * The node's current model is intentionally NOT preferred — a toggle resolves
 * fresh for the target mode (its remembered pick → recommended → first).
 * @param content - The node's current content view, read for `modelByMode` + `params` (may be undefined).
 * @param mode - The target generation sub-mode.
 * @param models - The full catalog image models (unfiltered).
 * @returns The model id + reconciled params to persist for the target mode.
 */
export function resolveModeSwitch(
  content: Pick<ContentNodeView, 'modelByMode' | 'params'> | undefined,
  mode: ImageGenMode,
  models: ModelEntry[],
): { model: string; params: Record<string, unknown> } {
  const generatable = models.filter((m) => isImageGenerationMode(m.mode));
  const modeModels = filterModelsByMode(generatable, mode);
  const model =
    resolveModelForMode(mode, content?.modelByMode ?? {}, modeModels) ?? '';
  const picked = modeModels.find((m) => m.name === model);
  const params = picked
    ? resolveParamsForModel(picked, content?.params ?? {})
    : {};
  return { model, params };
}

/**
 * Derives the Generate panel's render inputs from a node's live data.
 * @param input - The target node id, current nodes / edges, and catalog models.
 * @param input.nodeId - The node whose panel is open.
 * @param input.nodes - Current canvas node views (target + reference sources).
 * @param input.edges - Current canvas edges (incoming = references).
 * @param input.models - Catalog image models.
 * @returns The derived view-model.
 */
export function buildGeneratePanelViewModel(input: {
  nodeId: string;
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  edges: ReadonlyArray<CanvasEdge>;
  models: ModelEntry[];
}): GeneratePanelViewModel {
  // models is trusted: the catalog is sanitized at the API boundary
  // (sanitizeModelCatalog), so it is always a ModelEntry[]. Offer only
  // generatable image models — text-to-image / image-to-image / edit — dropping
  // pure tools (background removal, upscale), which belong in the mini-tool
  // system. Then narrow to the ACTIVE mode (mode toggle 2026-07-09) so the
  // picker shows one clean list per mode instead of every t2i/i2i variant.
  const { nodeId, nodes, edges } = input;
  const content = asContentView(nodes.find((n) => n.id === nodeId)?.data);
  const mode = resolveMode(content?.mode);
  const generatable = input.models.filter((m) => isImageGenerationMode(m.mode));
  const models = filterModelsByMode(generatable, mode);

  const model = pickModelForMode(content?.model, mode, content?.modelByMode, models);
  const current = models.find((m) => m.name === model);
  const params = current ? resolveParamsForModel(current, content?.params ?? {}) : {};

  const references = deriveReferences(nodeId, nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // t2i generates from scratch and ignores source images (design §2.5): the
  // rail still renders (greyed in the panel) but contributes NO reference URLs
  // to the execute payload. i2i sends them. (Style images — a future slice —
  // will be the one exception that survives t2i.)
  const referenceUrls =
    mode === 't2i'
      ? []
      : references
        .map((r) => assetUrlOf(byId.get(r.sourceNodeId)?.data))
      // The source node's content is collaborative Yjs data — untrusted, and
      // NOT covered by the catalog boundary. typeof, not Boolean: a malformed
      // source whose content is a non-string object is truthy and would slip
      // a non-URL into the task payload.
        .filter((u): u is string => typeof u === 'string' && u.length > 0);

  return {
    models,
    model,
    params,
    references,
    referenceUrls,
    // `?? 0` covers only the model-not-found case (empty catalog / stale model);
    // when current is found, cost_per_call is a trusted number (boundary).
    creditEstimate: current?.cost_per_call ?? 0,
    nodeStatus: content?.status,
    mode,
  };
}
