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

const budget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** The libx264 presets a presentation encode may use. */
export const x264PresetSchema = z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']) satisfies z.ZodType<MiniToolPlanTarget['preset']>;
/** Limits are validated at the edge and frozen for the original accepted job; the ledger has byte and parser budgets, never a frame count ceiling. */
export const videoPresentationProcessLimitsSchema: z.ZodType<VideoPresentationProcessLimits> = z.strictObject({
  sourceLedger: z.strictObject({
    maxBytes: budget, probeStdoutBytes: budget, metadataBytes: budget, isoBoxCount: budget, matroskaElementCount: budget, matroskaMaxBlocks: budget,
  }).optional(),
  maxSourceBytes: z.number().int().positive(), maxPackedBytes: z.number().int().positive(),
  crf: z.number().int().min(0).max(51), preset: x264PresetSchema,
  probeStdoutBytes: z.number().int().positive(), analysisStdoutBytes: z.number().int().positive(), stderrTailBytes: z.number().int().positive(),
});

const rate = z.number().positive().finite();
const colorTag = z.string().min(1);

/** The encoding parameters frozen at admission (design §3.2 item 1, §5.4): chunking, encoder rates, copy margin and carrier. */
export const videoPresentationEncodingSchema = z.strictObject({
  chunkShare: z.number().positive().max(1), maxParallelChunks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  encoder: z.strictObject({
    startSeconds: z.number().nonnegative().finite(), encodePixelsPerSecond: rate,
    decodeConvertPixelsPerSecond: z.strictObject({ sdr_8bit: rate, sdr_10bit: rate, sdr_12bit: rate, hdr_8bit: rate, hdr_10bit: rate, hdr_12bit: rate, sdr_16bit: rate, hdr_16bit: rate }),
    // Audio seconds encoded to AAC per second: the dispatched copy's estimate (§5.4).
    aacEncodeSecondsPerSecond: rate,
  }),
  copyDiskMarginBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  carrier: z.strictObject({ maxShortSide: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), color: z.strictObject({ primaries: colorTag, transfer: colorTag, matrix: colorTag, range: colorTag }) }),
});
/** A parsed frozen encoding policy. */
export type VideoPresentationEncoding = z.infer<typeof videoPresentationEncodingSchema>;

/** One combination that plays as itself (design §4.1); rotation, sample aspect and matrix tagging are fixed. */
export const videoPresentationIdentityFormatSchema = z.strictObject({
  container: z.string().min(1), videoCodec: z.string().min(1), profiles: z.array(z.string().min(1)).min(1),
  pixFmt: z.string().min(1), bitDepth: z.number().int().positive().max(16), audioCodecs: z.array(z.string().min(1)).min(1),
  rotation: z.literal(0), sar: z.literal('1:1'), matrixTagged: z.literal(true),
});
/** A parsed identity format. */
export type VideoPresentationIdentityFormat = z.infer<typeof videoPresentationIdentityFormatSchema>;
/** The probe facts frozen at admission (design §5.1 step 2, §4.2.1): sampled frames, single-frame duration, identity table. */
export const videoPresentationProbeSchema = z.strictObject({
  sampleFrames: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  singleFrameDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  identityFormats: z.array(videoPresentationIdentityFormatSchema),
});
/** Parsed frozen probe facts. */
export type VideoPresentationProbeFacts = z.infer<typeof videoPresentationProbeSchema>;

const storageKey = z.string().min(1).max(500);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const measuredObject = {
  storageKey, sha256: hash, sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), contentType: z.string().min(1).max(100),
};
/**
 * The measured receipt of one output, tagged with its role (§5.1 step 4, §90 E4-15): the carrier a stitch or copy attempt
 * wrote, an alpha-packed one with the packed geometry its job reported (§91 D3-3), or the manifest the DO wrote itself.
 */
export const videoPresentationOutputReceiptSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('carrier'), packing: z.enum(['native', 'alpha-packed']), ...measuredObject, geometry: packedGeometrySchema.optional() })
    .refine((receipt) => (receipt.packing === 'alpha-packed') === (receipt.geometry !== undefined), 'An alpha-packed carrier, and only one, carries its packed geometry'),
  z.strictObject({ role: z.literal('manifest'), ...measuredObject }),
]);
/** A parsed output receipt. */
export type VideoPresentationOutputReceipt = z.infer<typeof videoPresentationOutputReceiptSchema>;
/** A unit's stored receipts: exactly one carrier, and at most one manifest, only beside an alpha-packed carrier and at its own key. */
export const videoPresentationOutputReceiptsSchema = z.array(videoPresentationOutputReceiptSchema).min(1).superRefine((receipts, ctx) => {
  const carriers = receipts.filter((receipt) => receipt.role === 'carrier');
  const manifests = receipts.filter((receipt) => receipt.role === 'manifest');
  const packed = carriers.length === 1 && carriers[0]!.packing === 'alpha-packed';
  if (carriers.length !== 1 || manifests.length > (packed ? 1 : 0) || new Set(receipts.map((receipt) => receipt.storageKey)).size !== receipts.length) {
    ctx.addIssue({ code: 'custom', message: 'Expected one carrier, and at most one manifest at its own key beside an alpha-packed carrier' });
  }
});
/** What a stitch or copy Done carries: its one carrier; the manifest is the DO's own (§91 D3-3). */
export const videoPresentationDoneReceiptsSchema = z.array(videoPresentationOutputReceiptSchema).length(1)
  .refine((receipts) => receipts.length === 1 && receipts[0]!.role === 'carrier', 'A Done carries exactly its carrier');
