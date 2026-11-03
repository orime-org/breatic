// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The presentation policy frozen at admission (design §3.2 item 1, §5.1 step 2, §5.4): process limits, encoding and
 * the probe facts. Kept apart from the ingest client so a caller can validate them without the HTTP transport.
 */

import { z } from 'zod';
import type { VideoPresentationProcessLimits } from '@shared/upload/video-presentation-types.js';

const budget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Limits are validated at the edge and frozen for the original accepted job; the ledger has byte and parser budgets, never a frame count ceiling. */
export const videoPresentationProcessLimitsSchema: z.ZodType<VideoPresentationProcessLimits> = z.strictObject({
  sourceLedger: z.strictObject({
    maxBytes: budget, probeStdoutBytes: budget, metadataBytes: budget, isoBoxCount: budget, matroskaElementCount: budget, matroskaMaxBlocks: budget,
  }).optional(),
  maxSourceBytes: z.number().int().positive(), maxPackedBytes: z.number().int().positive(),
  crf: z.number().int().min(0).max(51), preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']),
  probeStdoutBytes: z.number().int().positive(), analysisStdoutBytes: z.number().int().positive(), stderrTailBytes: z.number().int().positive(),
});

const rate = z.number().positive().finite();
const colorTag = z.string().min(1);

/** The encoding parameters frozen at admission (design §3.2 item 1, §5.4): chunking, encoder rates, copy margin and carrier. */
export const videoPresentationEncodingSchema = z.strictObject({
  chunkShare: z.number().positive().max(1), maxParallelChunks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  encoder: z.strictObject({
    startSeconds: z.number().nonnegative().finite(), encodePixelsPerSecond: rate,
    decodeConvertPixelsPerSecond: z.strictObject({ sdr_8bit: rate, sdr_10bit: rate, sdr_12bit: rate, hdr_8bit: rate, hdr_10bit: rate, hdr_12bit: rate }),
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
