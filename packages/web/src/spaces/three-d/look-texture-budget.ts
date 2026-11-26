// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { SceneLook } from '@breatic/shared';

import { uploadBytes } from '@web/spaces/three-d/texture-upload-bytes';

/** Why a part picture cannot be shown. */
export type LookTextureReason = 'bytes' | 'unknown';
export type LookTextureVerdict = { usable: true } | { usable: false; reason: LookTextureReason };

/** The scene's texture limits, the edge capped by this device. */
export interface LookTextureLimits {
  maxTextureEdge: number;
  maxTextureBytes: number;
  /** Most bytes read to learn a picture's size from its header. */
  maxPictureHeaderBytes: number;
}

/** Everything one budget check reads. */
export interface LookTextureInput {
  /** Upload bytes of the model's own textures. */
  ownBytes: number;
  /** Extra bytes per part when it keeps the model picture with its own tiling, which three uploads as a separate texture. */
  clampBytes: Readonly<Record<string, number>>;
  look: SceneLook;
  /** Header sizes of the look pictures by address; null when the size could not be read. */
  sizes: ReadonlyMap<string, { width: number; height: number } | null>;
  /** The configured limits, the edge already capped by this device's largest texture. */
  limits: LookTextureLimits;
}

/** A picture's width and height in pixels. */
export interface LookPictureDimensions {
  width: number;
  height: number;
}

/**
 * The size a picture is shown at: scaled down, keeping its proportions, until its longest edge is within the limit
 * (Figma, PlayCanvas and three.js scale an oversized image the same way).
 * @param size - The picture's own size.
 * @param maxEdge - The longest edge allowed.
 * @returns The size it is decoded and counted at.
 */
export function fittedLookSize(size: LookPictureDimensions, maxEdge: number): LookPictureDimensions {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge) return { width: size.width, height: size.height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/**
 * The addresses a look shows as pictures: a part's map other than 'none'.
 * @param look - The look.
 * @returns Distinct picture ids.
 */
export function picturesOf(look: SceneLook): string[] {
  return [...new Set(Object.values(look).flatMap((fields) => (fields.map && fields.map !== 'none' ? [fields.map] : [])))];
}

/**
 * A part's place in panel order: its material index, the default part (the one key that is not an index) after every
 * index. At runtime the module imports only `texture-upload-bytes`, which shares its chunk, so the eager panel and the lazy
 * viewport share that chunk alone.
 * @param part - A part key.
 * @returns Its sort rank.
 */
export function lookPartRank(part: string): number {
  return /^\d+$/u.test(part) ? Number(part) : Number.POSITIVE_INFINITY;
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
 * Judge every look picture of one object against the texture budget (inner#1693 design 7): parts in order, each
 * distinct picture counted once at the size it is shown, a picture over the budget or of unknown size left out of the
 * total.
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
      const bytes = size ? uploadBytes(fittedLookSize(size, limits.maxTextureEdge), true) : 0;
      if (!size) verdict = { usable: false, reason: 'unknown' };
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

/**
 * The upload bytes an object's textures would take together: its own, its parts' own pictures with their own tiling,
 * and every distinct look picture of known size.
 * @param input - The object's budget input.
 * @returns The byte total.
 */
export function lookTextureTotal(input: LookTextureInput): number {
  let total = input.ownBytes;
  const pictures = new Set<string>();
  for (const [part, fields] of Object.entries(input.look)) {
    if (fields.map === undefined) {
      if (fields.mapRepeat !== undefined || fields.mapOffset !== undefined || fields.mapRotation !== undefined) total += input.clampBytes[part] ?? 0;
    } else if (fields.map !== 'none') pictures.add(fields.map);
  }
  for (const map of pictures) {
    const size = input.sizes.get(map);
    if (size) total += uploadBytes(fittedLookSize(size, input.limits.maxTextureEdge), true);
  }
  return total;
}

/** A look write to judge before it is made. */
export interface LookWriteCheck extends Omit<LookTextureInput, 'sizes'> {
  part: string;
  /** The picture the part would show. */
  map: string;
  /** Its size when already known (a local file), otherwise read through `size`. */
  mapSize?: { width: number; height: number } | null;
  /** A used picture's header size, or null when it cannot be read. */
  size: (url: string) => Promise<{ width: number; height: number } | null>;
}

/**
 * Judge putting a picture on a part from file headers alone (inner#1693 design 7): the write is refused when it would
 * make any picture unusable that was not already unusable with the same picture.
 * @param check - The object, the part, the picture and how to read sizes.
 * @returns The refusal with the bytes the object's textures would take, or null.
 */
export async function checkLookWrite(check: LookWriteCheck): Promise<{ reason: LookTextureReason; total: number } | null> {
  const used = new Set(picturesOf(check.look));
  used.add(check.map);
  const sizes = new Map(await Promise.all([...used].map(async (id) =>
    [id, id === check.map && check.mapSize !== undefined ? check.mapSize : await check.size(id)] as const)));
  const base = { ownBytes: check.ownBytes, clampBytes: check.clampBytes, limits: check.limits, sizes };
  const after = { ...base, look: { ...check.look, [check.part]: { ...check.look[check.part], map: check.map } } };
  const issue = lookWriteIssue({ ...base, look: check.look }, after, check.part);
  return issue ? { ...issue, total: lookTextureTotal(after) } : null;
}
