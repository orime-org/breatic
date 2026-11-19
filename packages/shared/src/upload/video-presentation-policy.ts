// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The presentation policy frozen at admission (design §3.2 item 1, §5.1 step 2, §5.4): process limits, encoding and
 * the probe facts. Kept apart from the ingest client so a caller can validate them without the HTTP transport.
 */

import { z } from 'zod';
import type { VideoPresentationProcessLimits } from '@shared/upload/video-presentation-types.js';
import type { MiniToolPlanTarget } from '@shared/upload/mini-tool-plan-types.js';
import { packedGeometrySchema } from '@shared/upload/video-presentation.js';
import { EDIT_FILE_TIERS } from '@shared/mini-tools/video-encode-plan.js';
import { SOURCE_DECODE_KEYS } from '@shared/upload/frame-grid-rate.js';

/** The libx264 presets a presentation encode may use. */
export const x264PresetSchema = z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']) satisfies z.ZodType<MiniToolPlanTarget['preset']>;
/** Limits are validated at the edge and frozen for the original accepted job; there is no frame count ceiling (§10.6). */
export const videoPresentationProcessLimitsSchema: z.ZodType<VideoPresentationProcessLimits> = z.strictObject({
  maxSourceBytes: z.number().int().positive(), maxPackedBytes: z.number().int().positive(),
  crf: z.number().int().min(0).max(51), preset: x264PresetSchema,
  probeStdoutBytes: z.number().int().positive(), analysisStdoutBytes: z.number().int().positive(), stderrTailBytes: z.number().int().positive(),
});

const rate = z.number().positive().finite();
const colorTag = z.string().min(1);
/**
 * One rate per key of a closed key list, every key required.
 * @param keys - The keys.
 * @returns The strict object schema.
 * @throws {never} Never.
 */
function rateTable<const K extends readonly string[]>(keys: K): z.ZodObject<Record<K[number], typeof rate>, z.core.$strict> {
  return z.strictObject(Object.fromEntries(keys.map(key => [key, rate])) as Record<K[number], typeof rate>);
}

/**
 * The encoding parameters frozen at admission (design §3.2 item 1, §5.4 estimate row): chunking, encoder rates (decode per
 * source key and per edit tier, encode for the playback carrier and per edit tier, tone mapping), the edit file's settings
 * and size cap (§4.2) and the carrier.
 */
export const videoPresentationEncodingSchema = z.strictObject({
  chunkShare: z.number().positive().max(1), maxParallelChunks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  encoder: z.strictObject({
    startSeconds: z.number().nonnegative().finite(), encodePixelsPerSecond: rate, tonemapPixelsPerSecond: rate,
    decodeConvertPixelsPerSecond: rateTable([...SOURCE_DECODE_KEYS, ...EDIT_FILE_TIERS]),
    editEncodePixelsPerSecond: rateTable(EDIT_FILE_TIERS),
    // Audio seconds encoded to AAC per second: the stem and stitch estimates (§5.4).
    aacEncodeSecondsPerSecond: rate,
  }),
  edit: z.strictObject({
    crf: z.number().int().min(0).max(51), preset: x264PresetSchema, proresProfile: z.string().min(1), bytesPerPixel: rate,
    maxEditBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  carrier: z.strictObject({ maxShortSide: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), color: z.strictObject({ primaries: colorTag, transfer: colorTag, matrix: colorTag, range: colorTag }) }),
});
/** A parsed frozen encoding policy. */
export type VideoPresentationEncoding = z.infer<typeof videoPresentationEncodingSchema>;

/** The probe facts frozen at admission (design §5.1 step 2, §4.1): sampled frames, single-frame duration and the rate cap. */
export const videoPresentationProbeSchema = z.strictObject({
  sampleFrames: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  singleFrameDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // `presentation.max_fps` of the rate rule (§4.1 frame rate row).
  maxFps: z.number().int().positive().max(1000),
});
/** Parsed frozen probe facts. */
export type VideoPresentationProbeFacts = z.infer<typeof videoPresentationProbeSchema>;

const storageKey = z.string().min(1).max(500);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const measuredObject = {
  storageKey, sha256: hash, sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), contentType: z.string().min(1).max(100),
};
/**
 * The measured receipt of one output, tagged with its role (§5.1 step 4, §90 E4-15): the carrier a stitch attempt
 * wrote, an alpha-packed one with the packed geometry its job reported (§91 D3-3), or the manifest the DO wrote itself.
 */
export const videoPresentationOutputReceiptSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('carrier'), packing: z.enum(['native', 'alpha-packed']), ...measuredObject, geometry: packedGeometrySchema.optional() })
    .refine((receipt) => (receipt.packing === 'alpha-packed') === (receipt.geometry !== undefined), 'An alpha-packed carrier, and only one, carries its packed geometry'),
  z.strictObject({ role: z.literal('manifest'), ...measuredObject }),
  // The edit file an edit stitch wrote (§4.2), with its tier.
  z.strictObject({ role: z.literal('edit'), ...measuredObject, tier: z.enum(EDIT_FILE_TIERS) }),
]);
/** A parsed output receipt. */
export type VideoPresentationOutputReceipt = z.infer<typeof videoPresentationOutputReceiptSchema>;
/** A unit's stored receipts: exactly one carrier, and at most one manifest, only beside an alpha-packed carrier and at its own key. */
export const videoPresentationOutputReceiptsSchema = z.array(videoPresentationOutputReceiptSchema).min(1).superRefine((receipts, ctx) => {
  const carriers = receipts.filter((receipt) => receipt.role === 'carrier');
  const manifests = receipts.filter((receipt) => receipt.role === 'manifest');
  const packed = carriers.length === 1 && carriers[0]!.packing === 'alpha-packed';
  // An edit stitch stores its edit file alone.
  if (receipts.length === 1 && receipts[0]!.role === 'edit') return;
  if (carriers.length !== 1 || manifests.length > (packed ? 1 : 0) || new Set(receipts.map((receipt) => receipt.storageKey)).size !== receipts.length) {
    ctx.addIssue({ code: 'custom', message: 'Expected one carrier, and at most one manifest at its own key beside an alpha-packed carrier' });
  }
});
/** What a stitch Done carries: its one carrier, or an edit stitch its edit file; the manifest is the DO's own (§91 D3-3). */
export const videoPresentationDoneReceiptsSchema = z.array(videoPresentationOutputReceiptSchema).length(1)
  .refine((receipts) => receipts.length === 1 && receipts[0]!.role !== 'manifest', 'A Done carries exactly its carrier or edit file');
