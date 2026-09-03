// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which catalog buckets each generate panel reads.
 *
 * A panel used to map one-to-one onto a bucket. Audio does not: voiceover and
 * voice cloning live in `tts`, sound effects and music in `audio`, and one
 * panel offers all four. Two places need that answer — the frame's gate,
 * which decides whether a panel may open at all, and each container's own
 * model list — so the mapping lives here rather than in both.
 */

import type { ModelCatalog, ModelEntry } from '@breatic/shared';

/** The modalities that have a node-anchored generate panel. */
export type GenerateModality = 'image' | 'video' | 'audio';

/**
 * The catalog buckets each panel draws its models from.
 *
 * The names collide with the modality on two of the three, which is why this
 * is written out: `data[modality]` compiles for audio and silently reads the
 * sound-effect and music models while the panel is offering voiceover.
 */
export const MODALITY_BUCKETS: Record<
  GenerateModality,
  ReadonlyArray<keyof Omit<ModelCatalog, 'total'>>
> = {
  image: ['image'],
  video: ['video'],
  audio: ['tts', 'audio'],
};

/**
 * Every model a panel of this modality can offer.
 * @param catalog - The fetched catalog, or undefined before it arrives.
 * @param modality - The modality whose panel is asking.
 * @returns The models from that modality's buckets, in bucket order.
 */
export function modelsForModality(
  catalog: ModelCatalog | undefined,
  modality: GenerateModality,
): ModelEntry[] {
  if (!catalog) return [];
  return MODALITY_BUCKETS[modality].flatMap((bucket) => catalog[bucket] ?? []);
}
