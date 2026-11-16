// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The presentation run contract between the basic presentation DO and its container (inner#1306 test plan §91 D-3;
 * design §5.1 step 2): one path, one action per request, each restarting from the source. The request names the
 * source and every frozen fact it needs; the probe answer carries the plan (checked by the shared plan schema), its
 * identities, the full ledger's encode facts, the route facts and the job work. Ledger and carrier arrive with D2.
 */

import { z } from 'zod';
import { videoPresentationEncodingSchema, videoPresentationProbeSchema, videoPresentationProcessLimitsSchema } from '@shared/upload/video-presentation-policy.js';
import { videoPresentationLedgerEncodingSchema, videoPresentationPlanSchema } from '@shared/upload/video-presentation-version.js';
import { videoPresentationOutputReceiptsSchema } from '@shared/upload/video-presentation-policy.js';
import { PRESENTATION_RUN_PATH } from '@ingest/presentation-run-types.js';

export { PRESENTATION_RUN_PATH };

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const frozen = {
  jobId: z.string().min(1).max(200), sourceFingerprint: hash, deadlineAt: count, sourceURL: z.url(),
  limits: videoPresentationProcessLimitsSchema.refine((limits) => limits.sourceLedger !== undefined, 'The run needs the source ledger budgets'),
  encoding: videoPresentationEncodingSchema, probe: videoPresentationProbeSchema,
};
// The ledger and carrier writes are authorized at the edge by the capability token and land beside the canonical key.
const writer = { ...frozen, token: z.string().min(1), storageKey: z.string().min(1).max(500) };

/** One request to the container; every action restarts from the source (§91 D-3). */
export const presentationRunRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('probe'), ...frozen }),
  // A null encodeFacts is a ledger-only repair: the container derives them again.
  z.strictObject({ action: z.literal('ledger'), ...writer, toolInputId: hash, encodeFacts: videoPresentationLedgerEncodingSchema.nullable() }),
  // Only the identity and the basic copy carriers are produced in basic; the identity receipt takes the registered type (§91 D2-7).
  z.strictObject({ action: z.literal('carrier'), ...writer, route: z.enum(['identity', 'copy']), contentType: z.string().min(1).max(100) }),
]);
/** A parsed run request. */
export type PresentationRunRequest = z.infer<typeof presentationRunRequestSchema>;

/** The probe's answer: a plan with the facts beside it, or a stable failure code. */
export const presentationProbeAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('planned'), toolInputId: hash, planSha256: hash, plan: videoPresentationPlanSchema, encoding: videoPresentationLedgerEncodingSchema,
    routeInput: z.strictObject({
      plan: z.strictObject({ planSha256: hash, producerVersion: count, profileVersion: count }),
      hdr: z.boolean(), alpha: z.enum(['confirmed_alpha', 'confirmed_opaque']), identityQualified: z.boolean(), colorMatrixTagged: z.boolean(),
      codec: z.string().min(1), copyPreservesTimeline: z.boolean(), audioCopyable: z.boolean(), sourceBytes: count,
    }),
    work: z.strictObject({
      encodedFrames: count, prerollFrames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sourceWidth: count, sourceHeight: count, outputWidth: count, outputHeight: count,
      bitDepth: z.union([z.literal(8), z.literal(10), z.literal(12), z.literal(16)]), hdr: z.boolean(), audioSeconds: z.number().finite().nonnegative(),
    }),
  }),
  z.strictObject({ kind: z.literal('failed'), code: z.string().regex(/^[a-z][a-z0-9_]*$/) }),
]).superRefine((answer, ctx) => {
  if (answer.kind === 'planned' && answer.routeInput.plan.planSha256 !== answer.planSha256) {
    ctx.addIssue({ code: 'custom', path: ['routeInput', 'plan', 'planSha256'], message: 'The route facts belong to another plan' });
  }
});

const failed = z.strictObject({ kind: z.literal('failed'), code: z.string().regex(/^[a-z][a-z0-9_]*$/) });
/** The ledger action's answer: written, or a stable failure code. */
export const presentationLedgerAnswerSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('written') }), failed]);
/** The carrier action's answer: the role-tagged receipts of the carrier, or a stable failure code. */
export const presentationCarrierAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('carrier'), receipts: videoPresentationOutputReceiptsSchema }), failed,
]);
