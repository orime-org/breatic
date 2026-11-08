// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a 3D generation reads off a catalog entry (inner#1691), the same in
 * the browser that picks an entry and the server that checks and lists runs.
 */

import { SCENE_VIEW_SLOTS, type ModelEntry } from "@shared/types/model-catalog.js";

/**
 * The modes one catalog entry declares. The field is one code or several,
 * and every reader has to agree on that and on what an empty code means: a
 * mode reported as available that the model lookup then matches nothing for
 * renders as no models at all.
 * @param entry - The catalog entry.
 * @returns Its modes, with empty codes dropped.
 */
export function modesOf(entry: Pick<ModelEntry, "mode">): string[] {
  return (Array.isArray(entry.mode) ? entry.mode : [entry.mode]).filter(Boolean);
}

/**
 * The param an entry takes its pictures in, and how many it takes.
 * @param entry - The 3D catalog entry.
 * @returns The param and its count, or none for an entry that takes no picture.
 */
export function picturesOf(entry: ModelEntry): { name: string; list: boolean; min: number; max: number } | null {
  for (const [name, spec] of Object.entries(entry.params)) {
    if (spec.accepts !== "image") continue;
    if (spec.type !== "list") return { name, list: false, min: 1, max: 1 };
    return { name, list: true, min: spec.min_items ?? 1, max: spec.max_items ?? SCENE_VIEW_SLOTS.length };
  }
  return null;
}
