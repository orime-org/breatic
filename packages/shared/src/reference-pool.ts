// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reference pool, one place per kind a model takes (#2156, design §13).
 *
 * The rail offers what is wired into a node and the prompt's `@` picks what a
 * run uses. A model declares, for each kind of material it takes that way, one
 * param filled from the pool (`fill: pool`) and what it accepts: most name
 * their picture list `images`, a few take `videos` and `audios` beside it,
 * and Kling O3 builds its `elements` out of the pictures. So the question a
 * panel asks is not "what is the pool called" but "under which param does a
 * mentioned picture, clip or track travel, and how many of each fit".
 */

import { itemCap } from "@shared/item-cap.js";
import { positiveCap } from "@shared/reference-cap.js";
import type { ParamDescriptor } from "@shared/types/model-catalog.js";

/** The kinds of node a pool can carry. */
export type ReferenceKind = "image" | "video" | "audio";

/** Every kind a pool can carry, in the order a submission lists them. */
export const REFERENCE_KINDS: readonly ReferenceKind[] = ["image", "video", "audio"];

/** Where one kind of reference travels, and how many of it fit. */
export interface PoolPlace {
  /** The param it travels under. */
  readonly param: string;
  /** The most one run takes, or undefined when the model caps none. */
  readonly cap: number | undefined;
  /** How a chip of this kind is written into the prompt, if the model says. */
  readonly mention: string | undefined;
}

/** The pool of one model in one mode: a place for each kind it takes. */
export type ReferencePool = Partial<Record<ReferenceKind, PoolPlace>>;

/**
 * Narrows a declared `accepts` to a kind the pool carries.
 * @param accepts - What the param says it takes.
 * @returns That kind, or undefined for anything else.
 */
function asKind(accepts: unknown): ReferenceKind | undefined {
  return REFERENCE_KINDS.find((kind) => kind === accepts);
}

/**
 * The places a model's pool offers under one mode.
 * @param model - The model's declarations, or undefined before one resolves.
 * @param mode - The mode the run is set to.
 * @returns One place per kind the model takes under that mode; empty when it
 *   takes none.
 */
export function referencePool(
  model: { readonly params: Readonly<Record<string, ParamDescriptor>> } | undefined,
  mode: string,
): ReferencePool {
  const pool: ReferencePool = {};
  for (const [param, spec] of Object.entries(model?.params ?? {})) {
    if (spec.fill !== "pool") continue;
    if (spec.modes !== undefined && !spec.modes.includes(mode)) continue;
    const kind = asKind(spec.accepts);
    if (kind !== undefined) pool[kind] = { param, cap: positiveCap(itemCap(spec)), mention: spec.mention };
  }
  return pool;
}

/**
 * The kinds of node a pool takes, in submission order.
 * @param pool - The pool, as {@link referencePool} answers it.
 * @returns Those kinds; empty when the pool takes nothing.
 */
export function referenceKinds(pool: ReferencePool): ReferenceKind[] {
  return REFERENCE_KINDS.filter((kind) => pool[kind] !== undefined);
}
