// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from 'zod';
import type { AlphaManifest, VideoPresentation } from '@shared/upload/video-presentation-types.js';
export type { AlphaManifest, VideoPresentation, VideoPresentationRect } from '@shared/upload/video-presentation-types.js';

export const pixel = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const coordinate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const httpsURL = z.url().refine((value) => value.startsWith('https://'), 'Expected HTTPS storage URL');
export const rect = z.strictObject({ x: coordinate, y: coordinate, width: pixel, height: pixel });
/** Complete trusted canonical display geometry and format duration. */
export const videoPresentationOriginalSchema = z.strictObject({ width: pixel, height: pixel, duration: z.number().finite().positive() });

/** The owned classification record, never a renderer configuration. */
const videoPresentationSchema: z.ZodType<VideoPresentation> = z.strictObject({
  schemaVersion: z.literal(1),
  sourceFingerprint: fingerprint,
  original: videoPresentationOriginalSchema,
  state: z.enum(['classifying', 'native', 'alpha_pending', 'alpha_ready', 'failed']),
  alpha: z.strictObject({ manifestURL: httpsURL }).optional(),
  attempt: z.strictObject({ jobId: z.string().min(1), deadlineAt: pixel }).optional(),
  error: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if ((value.state === 'classifying' || value.state === 'alpha_pending') && value.attempt === undefined) {
    ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'Pending presentation requires an accepted attempt' });
  }
  if (value.state === 'alpha_ready' && value.alpha === undefined) {
    ctx.addIssue({ code: 'custom', path: ['alpha'], message: 'Ready alpha presentation requires its manifest' });
  }
  if (value.state === 'failed' && value.error === undefined) {
    ctx.addIssue({ code: 'custom', path: ['error'], message: 'Failed presentation requires its reason' });
  }
  if ((value.state === 'native' || value.state === 'alpha_ready') && value.error !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['error'], message: 'Ready presentation cannot retain a failure' });
  }
});

/** The planes of an alpha-packed carrier, in the alpha manifest's field names (§3.5); checked by checkPackedGeometry. */
export const packedGeometrySchema = z.strictObject({ packedWidth: pixel, packedHeight: pixel, colorRect: rect, alphaRect: rect }).superRefine((value, ctx) => checkPackedGeometry(value, ctx));
/** Parsed packed geometry. */
export type PackedGeometry = z.infer<typeof packedGeometrySchema>;

/**
 * Check packed geometry: both rectangles inside the packed frame, equal in size and not overlapping; alignment padding is allowed.
 * @param value - Structurally valid packed geometry.
 * @param ctx - The refinement context receiving issues.
 * @throws {never} Never.
 */
export function checkPackedGeometry(value: Pick<AlphaManifest, 'packedWidth' | 'packedHeight' | 'colorRect' | 'alphaRect'>, ctx: z.RefinementCtx): void {
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

/** The packed derivative geometry permits encoding alignment padding. */
export const alphaManifestSchema: z.ZodType<AlphaManifest> = z.strictObject({
  schemaVersion: z.literal(1), sourceFingerprint: fingerprint, packedURL: httpsURL,
  packedWidth: pixel, packedHeight: pixel, colorRect: rect, alphaRect: rect,
}).superRefine(checkPackedGeometry);

/**
 * Derives a descriptor key from its registered canonical key.
 * @param key - Registered canonical storage key.
 * @returns Deterministic versioned descriptor key.
 * @throws {never} Never.
 */
export function videoPresentationKeyFor(key: string): string { return `${key}.video-presentation.v1.json`; }
/**
 * Reads a descriptor only when its shape and canonical fingerprint match.
 * @param value - Untrusted descriptor JSON.
 * @param sourceFingerprint - Registered canonical SHA256.
 * @returns A valid current descriptor, or null for unknown.
 * @throws {never} Malformed or obsolete JSON resolves to unknown.
 */
export function parseVideoPresentation(value: unknown, sourceFingerprint: string): VideoPresentation | null {
  const parsed = videoPresentationSchema.safeParse(value);
  return parsed.success && parsed.data.sourceFingerprint === sourceFingerprint ? parsed.data : null;
}
/**
 * Checks whether a valid manifest presents this descriptor's canonical source.
 * @param manifest - Parsed alpha manifest.
 * @param presentation - Parsed canonical descriptor.
 * @returns Whether both source and original display geometry match.
 * @throws {never} Never.
 */
export function alphaManifestMatchesPresentation(manifest: AlphaManifest, presentation: VideoPresentation): boolean {
  return manifest.sourceFingerprint === presentation.sourceFingerprint &&
    manifest.colorRect.width === presentation.original.width && manifest.colorRect.height === presentation.original.height &&
    manifest.alphaRect.width === presentation.original.width && manifest.alphaRect.height === presentation.original.height;
}
