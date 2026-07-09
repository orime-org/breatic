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
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import type {
  ContentNodeView,
  NodeView,
} from '@web/spaces/canvas/types/node-view';

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
 * Picks the effective model id: the node's stored model when it exists in the
 * catalog, else the first `recommended` model, else the first model.
 * @param stored - The node's stored model id (may be absent / stale).
 * @param models - The catalog models.
 * @returns The effective model id, or empty string for an empty catalog.
 */
function pickModel(stored: string | undefined, models: ModelEntry[]): string {
  if (stored && models.some((m) => m.name === stored)) return stored;
  const recommended = models.find((m) => m.tier === 'recommended');
  return recommended?.name ?? models[0]?.name ?? '';
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
  // generatable image models in the picker — text-to-image / image-to-image /
  // edit — and drop pure tools (background removal, upscale), which belong in
  // the mini-tool system, not the Generate panel.
  const { nodeId, nodes, edges } = input;
  const models = input.models.filter((m) => isImageGenerationMode(m.mode));
  const content = asContentView(nodes.find((n) => n.id === nodeId)?.data);

  const model = pickModel(content?.model, models);
  const current = models.find((m) => m.name === model);
  const params = current ? resolveParamsForModel(current, content?.params ?? {}) : {};

  const references = deriveReferences(nodeId, nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const referenceUrls = references
    .map((r) => assetUrlOf(byId.get(r.sourceNodeId)?.data))
    // The source node's content is collaborative Yjs data — untrusted, and NOT
    // covered by the catalog boundary. typeof, not Boolean: a malformed source
    // whose content is a non-string object is truthy and would slip a non-URL
    // into the task payload.
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
  };
}
