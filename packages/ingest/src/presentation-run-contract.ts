// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The presentation probe contract between the basic presentation DO and its container (frames-split design §5.1 step 2, §3.2,
 * §4.1, §4.2): one request naming the source and every frozen fact; the answer carries the plan (checked by the shared plan
 * schema), its digest, the sha256 producer, playback and edit profile versions, the tool-source facts and the grid inputs.
 */

import { z } from 'zod';
import { EDIT_FILE_TIERS } from '@shared/mini-tools/video-encode-plan.js';
import { SOURCE_DECODE_KEYS } from '@shared/upload/frame-grid-rate.js';
import { videoPresentationEncodingSchema, videoPresentationProbeSchema, videoPresentationProcessLimitsSchema } from '@shared/upload/video-presentation-policy.js';
import { positiveRationalSchema, rationalTimeSchema, sourceKeyframeStatsSchema, videoPresentationPlanSchema } from '@shared/upload/video-presentation-version.js';
import { PRESENTATION_RUN_PATH } from '@ingest/presentation-run-types.js';

export { PRESENTATION_RUN_PATH };

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// A probe time is exact but not reduced: ticks times the stream time base.
const time = z.strictObject({ numerator: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), denominator: count });

/** The probe request; it restarts from the source. */
export const presentationRunRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('probe'), jobId: z.string().min(1).max(200), sourceFingerprint: hash, deadlineAt: count, sourceURL: z.url(),
    limits: videoPresentationProcessLimitsSchema, encoding: videoPresentationEncodingSchema, probe: videoPresentationProbeSchema,
  }),
]);
/** A parsed run request. */
export type PresentationRunRequest = z.infer<typeof presentationRunRequestSchema>;

/** The probe's answer: a plan with the facts beside it, or a stable failure code. */
export const presentationProbeAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('planned'), plan: videoPresentationPlanSchema, planSha256: hash,
    versions: z.strictObject({ producerVersion: hash, profileVersion: hash, editProfileVersion: hash.nullable() }),
    source: z.strictObject({
      sourceDecodeKey: z.enum(SOURCE_DECODE_KEYS), keyframes: sourceKeyframeStatsSchema, hdr: z.boolean(), alpha: z.boolean(), editTier: z.enum(EDIT_FILE_TIERS).nullable(), seekable: z.boolean(),
      bitDepth: z.number().int().positive().max(32),
      color: z.strictObject({ matrix: z.string().min(1), transfer: z.string().min(1).nullable(), primaries: z.string().min(1).nullable(), range: z.enum(['tv', 'pc']), chromaLocation: z.string().min(1) }),
    }),
    gridInput: z.strictObject({ fps: positiveRationalSchema, firstVideoTime: time, firstAudioFrameTime: time.nullable(), audioEnd: rationalTimeSchema.nullable(), quantum: time }),
    estimate: z.strictObject({ lastVideoTime: time, sourceFrames: count, frameCount: count, realFrameCount: count }),
    sourceBytes: count,
  }),
  z.strictObject({ kind: z.literal('failed'), code: z.string().regex(/^[a-z][a-z0-9_]*$/) }),
]).superRefine((answer, ctx) => {
  if (answer.kind !== 'planned') return;
  if ((answer.plan.toolSource === 'edit') !== (answer.source.editTier !== null) || (answer.source.editTier === null) !== (answer.versions.editProfileVersion === null)) {
    ctx.addIssue({ code: 'custom', path: ['source', 'editTier'], message: 'An edit tier, an edit-file plan and an edit profile version go together' });
  }
});
/** A parsed probe answer. */
export type PresentationProbeAnswerParsed = z.infer<typeof presentationProbeAnswerSchema>;
