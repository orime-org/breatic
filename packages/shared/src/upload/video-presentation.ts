// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from 'zod';
import type { VideoPresentationRect } from '@shared/upload/video-presentation-types.js';
export type { VideoPresentationOriginal, VideoPresentationRect } from '@shared/upload/video-presentation-types.js';

export const pixel = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const coordinate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const rect = z.strictObject({ x: coordinate, y: coordinate, width: pixel, height: pixel });
/** Complete trusted canonical display geometry and format duration. */
export const videoPresentationOriginalSchema = z.strictObject({ width: pixel, height: pixel, duration: z.number().finite().positive() });

/** The planes of an alpha-packed carrier, in the alpha manifest's field names (§3.5); checked by checkPackedGeometry. */
export const packedGeometrySchema = z.strictObject({ packedWidth: pixel, packedHeight: pixel, colorRect: rect, alphaRect: rect }).superRefine((value, ctx) => checkPackedGeometry(value, ctx));
/** Parsed packed geometry. */
export type PackedGeometry = z.infer<typeof packedGeometrySchema>;

/** The packed frame and the two planes inside it, as the alpha manifest and a packed report name them. */
interface PackedPlanes { packedWidth: number; packedHeight: number; colorRect: VideoPresentationRect; alphaRect: VideoPresentationRect }

/**
 * Check packed geometry: both rectangles inside the packed frame, equal in size and not overlapping; alignment padding is allowed.
 * @param value - Structurally valid packed geometry.
 * @param ctx - The refinement context receiving issues.
 * @throws {never} Never.
 */
export function checkPackedGeometry(value: PackedPlanes, ctx: z.RefinementCtx): void {
  const { colorRect: color, alphaRect: alpha, packedWidth, packedHeight } = value;
  for (const [name, area] of [['colorRect', color], ['alphaRect', alpha]] as const) {
    if (area.x > packedWidth - area.width || area.y > packedHeight - area.height) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'Rectangle exceeds packed dimensions' });
    }
  }
  if (color.width !== alpha.width || color.height !== alpha.height) {
    ctx.addIssue({ code: 'custom', path: ['alphaRect'], message: 'Color and alpha dimensions must match' });
  }
  if (!(color.x + color.width <= alpha.x || alpha.x + alpha.width <= color.x || color.y + color.height <= alpha.y || alpha.y + alpha.height <= color.y)) {
    ctx.addIssue({ code: 'custom', path: ['alphaRect'], message: 'Color and alpha rectangles must not overlap' });
  }
}

/**
 * Derives a descriptor key from its registered canonical key.
 * @param key - Registered canonical storage key.
 * @returns Deterministic versioned descriptor key.
 * @throws {never} Never.
 */
export function videoPresentationKeyFor(key: string): string { return `${key}.video-presentation.v1.json`; }
