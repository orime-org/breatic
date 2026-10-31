// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which catalog buckets each generate panel reads.
 *
 * A panel used to map one-to-one onto a bucket. Audio does not: text to speech and
 * voice cloning live in `tts`, sound effects and music in `audio`, and one
 * panel offers all four. Two places need that answer — the frame's gate,
 * which decides whether a panel may open at all, and each container's own
 * model list — so the mapping lives here rather than in both.
 */

import {
  GENERATION_NODE_BUCKETS,
  type GenerationNodeType,
  type ModelCatalog,
  type ModelEntry,
} from '@breatic/shared';

/**
 * Every model a panel of this modality can offer.
 * @param catalog - The fetched catalog, or undefined before it arrives.
 * @param modality - The modality whose panel is asking.
 * @returns The models from that modality's buckets, in bucket order.
 */
export function modelsForModality(
  catalog: ModelCatalog | undefined,
  modality: GenerationNodeType,
): ModelEntry[] {
  if (!catalog) return [];
  return GENERATION_NODE_BUCKETS[modality].flatMap((bucket) => catalog[bucket] ?? []);
}

/**
 * Every model the catalog serves for any generating node type: a template's
 * nodes can run in several (inner#1345).
 * @param catalog - The model catalog, or undefined before it loads.
 * @returns The models.
 */
export function allGenerationModels(catalog: ModelCatalog | undefined): ModelEntry[] {
  return (['image', 'video', 'audio'] as const).flatMap((modality) => modelsForModality(catalog, modality));
}
