// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure derivation of the Generate panel's render inputs from a node's live Yjs
 * data + the model catalog. Kept out of the container so the model-default
 * pick, param reconciliation, reference rail, and reference-URL snapshot are
 * all unit-testable without React / Yjs / react-query.
 */

import {
  isImageGenerationMode,
  requiresSourceImage,
  type ModelEntry,
} from '@breatic/shared';

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

/** Shared empty set for nodes with no `@`-picked references (avoids per-call allocation). */
const EMPTY_SOURCE_IDS: ReadonlySet<string> = new Set();

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
  /**
   * Whether the effective model needs a source image (i2i / edit modes). Drives
   * the #1675 execute gate: submitting one of these with no `@`-picked source
   * image is blocked in the panel (and re-checked server-side before billing).
   * False when the catalog is empty (no model resolved) — nothing to gate.
   */
  requiresSource: boolean;
  /**
   * Whether the GLOBAL generatable-image catalog is empty (still loading, failed
   * to load, or no generation model configured). Distinct from `models.length`,
   * which is the ACTIVE-mode-filtered subset: the mode toggle gates its disabled
   * state on THIS (not the mode subset) so a node stuck in a mode with zero
   * models can still toggle back to the populated mode (adversarial round 2).
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
 * Reads an IMAGE node's asset URL — the only valid i2i source. A connected
 * non-image node (audio / video / 3d / web) can be @-mentioned (the pool has no
 * type filter), but its URL must never ride into `params.images` as a source
 * image, so every non-image kind yields undefined (adversarial 2026-07-10). An
 * i2i source is definitionally an image; text content is a body, not a URL.
 * @param data - The source node view.
 * @returns The image URL, or undefined when the source is not an image node.
 */
function imageUrlOf(data: NodeView | undefined): string | undefined {
  return data?.kind === 'image' ? data.content : undefined;
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
 * Narrows the sanitized catalog to the models offered under a panel mode.
 *
 * models is trusted (sanitizeModelCatalog at the API boundary). Offers only
 * generatable image models — text-to-image / image-to-image / edit — dropping
 * pure tools (background removal, upscale), which belong in the mini-tool
 * system; then narrows to the ACTIVE mode (mode toggle 2026-07-09) so the
 * picker shows one clean list per mode. Exported so the container can memoize
 * the SAME selection on [models, mode] alone — the view-model rebuilds every
 * canvas graph mutation, and a freshly-filtered array each time would defeat
 * the React.memo on the pickers (round-2 adversarial; memo discipline).
 * @param models - The sanitized catalog models.
 * @param mode - The active generation sub-mode.
 * @returns The models offered under that mode.
 */
export function selectModeModels(
  models: ModelEntry[],
  mode: ImageGenMode,
): ModelEntry[] {
  const generatable = models.filter((m) => isImageGenerationMode(m.mode));
  return filterModelsByMode(generatable, mode);
}

/**
 * Derives the Generate panel's render inputs from a node's live data.
 * @param input - The target node id, current nodes / edges, and catalog models.
 * @param input.nodeId - The node whose panel is open.
 * @param input.nodes - Current canvas node views (target + reference sources).
 * @param input.edges - Current canvas edges (incoming = references).
 * @param input.models - Catalog image models.
 * @param input.atMentionedSourceIds - Source node ids `@`-picked in the prompt; only these feed the i2i execute payload (design B — no `@` = no source image). Absent = none picked.
 * @returns The derived view-model.
 */
export function buildGeneratePanelViewModel(input: {
  nodeId: string;
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  edges: ReadonlyArray<CanvasEdge>;
  models: ModelEntry[];
  atMentionedSourceIds?: ReadonlySet<string>;
}): GeneratePanelViewModel {
  const { nodeId, nodes, edges } = input;
  const content = asContentView(nodes.find((n) => n.id === nodeId)?.data);
  const mode = resolveMode(content?.mode);
  // Wide filter kept separately: catalogEmpty means "no generatable model in
  // ANY mode" (it gates the whole panel), while `models` narrows to the
  // active mode via the same selection the container memoizes.
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
  // i2i sends ONLY the @-picked source images (design B): a reference that is
  // connected but not @-mentioned contributes nothing; no @ at all → empty, and
  // the #1675 execute gate then blocks submitting an i2i task with no source.
  const atMentioned = input.atMentionedSourceIds ?? EMPTY_SOURCE_IDS;
  const referenceUrls =
    mode === 't2i'
      ? []
      : references
        .filter((r) => atMentioned.has(r.sourceNodeId))
        .map((r) => imageUrlOf(byId.get(r.sourceNodeId)?.data))
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
    // Source-image gate (#1675): the ACTIVE PANEL MODE decides the submission
    // semantics — under t2i nothing needs a source image, even for a HYBRID
    // model whose capability list also spans i2i (round-2 adversarial: keying
    // on the capability array alone made t2i permanently unexecutable for
    // hybrids, since t2i clears referenceUrls). Under i2i, defer to the
    // model's declared modes. No model resolved (empty catalog) → no gate.
    requiresSource:
      mode === 'i2i' && current ? requiresSourceImage(current.mode) : false,
    catalogEmpty: generatable.length === 0,
  };
}
