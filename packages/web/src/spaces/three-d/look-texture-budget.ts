// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { SCENE_LOOK_DEFAULT_PART, type SceneLook } from '@breatic/shared';

import { uploadBytes } from '@web/spaces/three-d/model-texture-metadata';

/** Why a part picture cannot be shown. */
export type LookTextureReason = 'edge' | 'bytes' | 'unknown';
export type LookTextureVerdict = { usable: true } | { usable: false; reason: LookTextureReason };

/** Everything one budget check reads. */
export interface LookTextureInput {
  /** Upload bytes of the model's own textures. */
  ownBytes: number;
  /** Extra bytes per part when it keeps the model picture with its own tiling, which three uploads as a separate texture. */
  clampBytes: Readonly<Record<string, number>>;
  look: SceneLook;
  /** Header sizes of the look pictures by asset id; null when the size could not be read. */
  sizes: ReadonlyMap<string, { width: number; height: number } | null>;
  /** The configured limits, the edge already capped by this device's largest texture. */
  limits: { maxTextureEdge: number; maxTextureBytes: number };
}

/**
 * A part's place in panel order: its material index, the default part after every index.
 * @param part - A part key.
 * @returns Its sort rank.
 */
export function lookPartRank(part: string): number {
  return part === SCENE_LOOK_DEFAULT_PART ? Number.POSITIVE_INFINITY : Number(part);
}

/**
 * Parts in panel order: material indices ascending, the default part last.
 * @param look - The look.
 * @returns Its part keys in order.
 */
function partOrder(look: SceneLook): string[] {
  return Object.keys(look).sort((a, b) => lookPartRank(a) - lookPartRank(b));
}

/**
 * Judge every look picture of one object against the texture limits (inner#1693 design 7): parts in order, each
 * distinct picture judged and counted once, a picture over a limit or of unknown size left out of the total.
 * @param input - The object's own bytes, clamp bytes, look, picture sizes and limits.
 * @returns A verdict per part that names a picture; parts with `none` or no picture have none.
 */
export function checkLookTextures(input: LookTextureInput): Map<string, LookTextureVerdict> {
  const { look, sizes, limits } = input;
  const verdicts = new Map<string, LookTextureVerdict>();
  const judged = new Map<string, LookTextureVerdict>();
  let total = input.ownBytes;
  for (const part of partOrder(look)) {
    const fields = look[part] ?? {};
    const map = fields.map;
    if (map === undefined) {
      const tiled = fields.mapRepeat !== undefined || fields.mapOffset !== undefined || fields.mapRotation !== undefined;
      if (tiled) total += input.clampBytes[part] ?? 0;
      continue;
    }
    if (map === 'none') continue;
    let verdict = judged.get(map);
    if (!verdict) {
      const size = sizes.get(map) ?? null;
      const bytes = size ? uploadBytes(size, true) : 0;
      if (!size) verdict = { usable: false, reason: 'unknown' };
      else if (Math.max(size.width, size.height) > limits.maxTextureEdge) verdict = { usable: false, reason: 'edge' };
      else if (total + bytes > limits.maxTextureBytes) verdict = { usable: false, reason: 'bytes' };
      else {
        verdict = { usable: true };
        total += bytes;
      }
      judged.set(map, verdict);
    }
    verdicts.set(part, verdict);
  }
  return verdicts;
}

/**
 * Whether a look write would make a picture unusable that was not already unusable with the same picture before it.
 * @param before - The object's budget input before the write.
 * @param after - The same input with the written look.
 * @param part - The written part, whose own issue is reported first.
 * @returns The reason to refuse the write, or null.
 */
export function lookWriteIssue(before: LookTextureInput, after: LookTextureInput, part: string): { reason: LookTextureReason } | null {
  const was = checkLookTextures(before);
  const now = checkLookTextures(after);
  const parts = [part, ...[...now.keys()].filter((key) => key !== part)];
  for (const key of parts) {
    const verdict = now.get(key);
    if (!verdict || verdict.usable) continue;
    const previous = was.get(key);
    const samePicture = before.look[key]?.map === after.look[key]?.map;
    if (!previous || previous.usable || !samePicture) return { reason: verdict.reason };
  }
  return null;
}
