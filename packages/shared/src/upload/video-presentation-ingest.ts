// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ContainerUsage } from '@shared/upload/container-usage.js';
import { z } from 'zod';
import { videoPresentationOriginalSchema } from '@shared/upload/video-presentation.js';
import {
  rationalTimeSchema, sourceKeyframeStatsSchema, verifyVideoPresentationPlan, videoPresentationDisplaySchema, videoPresentationPlanSchema, videoPresentationVersionSchema,
  type VideoPresentationVersion,
} from '@shared/upload/video-presentation-version.js';
import { EDIT_FILE_TIERS, videoCarrierRouteStages, type VideoCarrierStage } from '@shared/mini-tools/video-encode-plan.js';
import { miniToolPlanColorInputsSchema } from '@shared/upload/mini-tool-plan-job.js';
import { askWorker } from '@shared/upload/ingest-client.js';
export { videoPresentationWorkKeyFor } from '@shared/upload/video-presentation-keys.js';
import {
  videoPresentationDoneReceiptsSchema, videoPresentationEncodingSchema, videoPresentationOutputReceiptsSchema, videoPresentationProbeSchema, videoPresentationProcessLimitsSchema, x264PresetSchema,
} from '@shared/upload/video-presentation-policy.js';
export {
  videoPresentationEncodingSchema, videoPresentationProbeSchema, videoPresentationProcessLimitsSchema,
  videoPresentationOutputReceiptSchema, videoPresentationOutputReceiptsSchema, videoPresentationDoneReceiptsSchema, x264PresetSchema,
  type VideoPresentationEncoding, type VideoPresentationProbeFacts, type VideoPresentationOutputReceipt,
} from '@shared/upload/video-presentation-policy.js';
export type { VideoPresentationProcessLimits } from '@shared/upload/video-presentation-types.js';
export type { VideoPresentationRegisteredMetadata } from '@shared/upload/video-presentation-types.js';
/** Actual configured instance size and rates captured before compute starts. */
export interface VideoPresentationPricing {
  containerClass: string;
  size: { vcpu: number; memory_gib: number; disk_gb: number };
  prices: { vcpu_second_usd: number; memory_gib_second_usd: number; disk_gb_second_usd: number };
}
/** One durable measured platform expense; database acknowledgement is independent. */
export interface VideoPresentationUsageFact {
  jobId: string;
  actorUserId: string;
  projectId: string | null;
  usage: ContainerUsage;
  pricing: VideoPresentationPricing;
}

/** Both container prices, frozen together at admission (design §3.5): basic probes, standard-4 counts and encodes. */
export interface VideoPresentationIngestPricing { basic: VideoPresentationPricing; standard4: VideoPresentationPricing }
/** The retry caps frozen at admission. */
export interface VideoPresentationAdmissionPolicy { chunkRetries: number }
/** The internal source binding: the registered storage key and the source bytes' fingerprint. */
export interface VideoPresentationIngestSourceBinding { storageKey: string; sourceFingerprint: string }
/** The target policy's preparation: the original job, its real stage and its failure code. */
export interface VideoPresentationIngestPreparation {
  targetPolicyVersion: number;
  jobId: string;
  stage: VideoCarrierStage | null;
  failure: string | null;
}
/** A read: the selected bundle and the target policy's preparation, never a full array (§3.5, §5.1 step 6). */
export interface VideoPresentationIngestSnapshot {
  sourceBinding: VideoPresentationIngestSourceBinding;
  presentation: VideoPresentationVersion | null;
  preparation: VideoPresentationIngestPreparation | null;
  /** The DO's fact that a discovery read may readmit once: P is invalid(V) and V's publisher, admitted without readmitOf, is current. */
  readmit: boolean;
  usageFact?: VideoPresentationUsageFact;
}
const usage = z.strictObject({ wallMs: z.number().finite().nonnegative(), cpuUsec: z.number().finite().nonnegative().nullable() });
export const videoPresentationPricingSchema: z.ZodType<VideoPresentationPricing> = z.strictObject({
  containerClass: z.string().min(1),
  size: z.strictObject({ vcpu: z.number().positive(), memory_gib: z.number().positive(), disk_gb: z.number().positive() }),
  prices: z.strictObject({ vcpu_second_usd: z.number().nonnegative(), memory_gib_second_usd: z.number().nonnegative(), disk_gb_second_usd: z.number().nonnegative() }),
});
const retryCap = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const errorCode = z.string().regex(/^[a-z][a-z0-9_]*$/);
const STAGES = ['plan', 'count', 'edit', 'edit_stitch', 'encode', 'stitch', 'publish'] as const satisfies readonly VideoCarrierStage[];
const stage = z.enum(STAGES);
/** The target policy's preparation, shared by the ingest snapshot and the web response. */
export const videoPresentationIngestPreparationSchema: z.ZodType<VideoPresentationIngestPreparation> = z.strictObject({
  targetPolicyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), jobId: z.string().min(1),
  stage: stage.nullable(), failure: errorCode.nullable(),
});

/**
 * Check that the selected bundle belongs to the source.
 * @param value - The selected bundle.
 * @param value.presentation - The selected bundle, or null.
 * @param sourceFingerprint - The source's fingerprint.
 * @param ctx - Where issues go.
 * @throws {never} Never.
 */
export function checkSelectedVideoPresentation(value: { presentation: VideoPresentationVersion | null }, sourceFingerprint: string, ctx: z.RefinementCtx): void {
  if (value.presentation !== null && value.presentation.sourceFingerprint !== sourceFingerprint) {
    ctx.addIssue({ code: 'custom', path: ['presentation'], message: 'The selected bundle belongs to another source' });
  }
}

/** Internal response parser is shared by the backend client and ingest writer. */
export const videoPresentationIngestSnapshotSchema: z.ZodType<VideoPresentationIngestSnapshot> = z.strictObject({
  sourceBinding: z.strictObject({ storageKey: z.string().min(1).max(500), sourceFingerprint: hash }),
  presentation: videoPresentationVersionSchema.nullable(),
  preparation: videoPresentationIngestPreparationSchema.nullable(),
  readmit: z.boolean(),
  usageFact: z.strictObject({ jobId: z.string().min(1), actorUserId: z.uuid(), projectId: z.uuid().nullable(), usage, pricing: videoPresentationPricingSchema }).optional(),
}).superRefine((value, ctx) => checkSelectedVideoPresentation(value, value.sourceBinding.sourceFingerprint, ctx));

const storageKey = z.string().min(1).max(500);
const jobId = z.string().min(1).max(200);
const deadlineAt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const attemptNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Grid frame windows that tile [0, n) without gaps.
const frameChunks = z.array(z.strictObject({ start: index, end: index })).min(1).refine(
  chunks => chunks.every((chunk, at) => chunk.end > chunk.start && chunk.start === (at === 0 ? 0 : chunks[at - 1]!.end)), 'Chunks tile the frames from 0 without gaps');
const identity = { storageKey, sourceFingerprint: hash, jobId };
const capability = { ...identity, deadlineAt, token: z.string().min(1) };

/** One presentation container unit, without its job id (§5.4 job identity): the count, playback and edit chunks and their stitches. */
export const videoPresentationChunkUnitSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('presentation-count') }),
  z.strictObject({ kind: z.literal('presentation-chunk'), chunk: index }),
  z.strictObject({ kind: z.literal('presentation-stitch') }),
  z.strictObject({ kind: z.literal('presentation-edit'), chunk: index }),
  z.strictObject({ kind: z.literal('presentation-edit-stitch') }),
]);
/** A parsed unit. */
export type VideoPresentationChunkUnit = z.infer<typeof videoPresentationChunkUnitSchema>;
/** One attempt report of a unit (§7.1.1). */
export const videoPresentationChunkReportSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('Sub') }),
  // A stitch names the carrier it wrote and an edit stitch the edit file; the count reports the last real frame's display
  // time and the decoded frames (§4.1 frame count row, §7.17 grid_count) and writes no object.
  z.strictObject({
    kind: z.literal('Done'), attempt: attemptNumber, usage: z.number().nonnegative().finite(), receipts: videoPresentationDoneReceiptsSchema.optional(),
    count: z.strictObject({ lastVideoTime: rationalTimeSchema, sourceFrames: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional(),
  }),
  z.strictObject({ kind: z.literal('Fail'), attempt: attemptNumber, code: errorCode, usage: z.number().nonnegative().finite().nullable() }),
  z.strictObject({ kind: z.literal('Exp') }),
  z.strictObject({ kind: z.literal('Rec'), attempt: attemptNumber }),
]);
/** A parsed unit report. */
export type VideoPresentationChunkReport = z.infer<typeof videoPresentationChunkReportSchema>;

/** Plain internal calls; only ingest owns storage and container execution. Admission and read carry the target policy. */
export const videoPresentationIngestRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read'), storageKey, sourceFingerprint: hash, targetPolicyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({
    action: z.literal('accept'), ...identity, deadlineAt,
    original: videoPresentationOriginalSchema.nullable(),
    registeredMetadata: z.strictObject({ width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(), duration: z.number().finite().positive().nullable() }).optional(),
    contentType: z.string().min(1), repair: z.boolean().optional(),
    // A discovery read's condition, re-checked by the DO in its serial entry (§3.5): still nothing selected or prepared, or still readmit.
    expect: z.enum(['first', 'readmit']).optional(),
    limits: videoPresentationProcessLimitsSchema,
    pricing: z.strictObject({ basic: videoPresentationPricingSchema, standard4: videoPresentationPricingSchema }),
    targetPolicyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    policy: z.strictObject({ chunkRetries: retryCap }),
    encoding: videoPresentationEncodingSchema,
    probe: videoPresentationProbeSchema,
    actorUserId: z.uuid(), projectId: z.uuid().nullable(),
    // Every derived object's URL is this base joined to its key (videoPresentationObjectURL).
    publicBaseURL: z.url().refine(value => value.startsWith('https://') && !value.endsWith('/'), 'Expected an https base without a trailing slash'),
  }),
  z.strictObject({ action: z.literal('prepare'), ...identity }),
  z.strictObject({ action: z.literal('advance_stage'), ...capability, stage }),
  z.strictObject({ action: z.literal('report_chunk'), ...capability, unit: videoPresentationChunkUnitSchema, report: videoPresentationChunkReportSchema }).superRefine((value, ctx) => {
    // A stitch names its carrier and an edit stitch its edit file; a chunk's outputs are named by their job id alone.
    if (value.report.kind !== 'Done') return;
    const role = value.unit.kind === 'presentation-stitch' ? 'carrier' : value.unit.kind === 'presentation-edit-stitch' ? 'edit' : undefined;
    if ((value.report.receipts?.[0]?.role) !== role) {
      ctx.addIssue({ code: 'custom', path: ['report', 'receipts'], message: 'A stitch Done carries its carrier, an edit stitch Done its edit file and a chunk or count Done none' });
    }
    if ((value.report.count !== undefined) !== (value.unit.kind === 'presentation-count')) {
      ctx.addIssue({ code: 'custom', path: ['report', 'count'], message: 'Exactly a count Done carries the count' });
    }
  }),
  // Only the job's measured usage travels; a bundle is assembled by the DO itself (§5.1 step 4).
  z.strictObject({ action: z.literal('report'), ...capability, fact: z.strictObject({ kind: z.literal('finished'), usage }) }),
  z.strictObject({ action: z.literal('fail'), ...identity, deadlineAt, code: errorCode }),
  z.strictObject({ action: z.literal('ack_usage'), ...identity, deadlineAt }),
]);
/** A parsed internal request. */
export type VideoPresentationIngestRequest = z.infer<typeof videoPresentationIngestRequestSchema>;

/** The worker-only answer to `prepare` (E2-3): the snapshot plus the capability, plan, work, units and frozen facts. */
export const videoPresentationPrepareAnswerSchema = z.strictObject({
  sourceBinding: z.strictObject({ storageKey, sourceFingerprint: hash }),
  presentation: videoPresentationVersionSchema.nullable(),
  preparation: videoPresentationIngestPreparationSchema.nullable(),
  usageFact: z.strictObject({ jobId: z.string().min(1), actorUserId: z.uuid(), projectId: z.uuid().nullable(), usage, pricing: videoPresentationPricingSchema }).optional(),
  capability: z.strictObject({ token: z.string().min(1), deadlineAt }).nullable(),
  // toolInputId is null until an edit file is written and measured (§3.2 item 3). The plan object itself, adopted only when
  // its digest is planSha256, and the probe facts each unit recipe is written from (§5.1 2a row, §7.17): the candidate's
  // display grid (the probe's estimate until the count makes it exact), the colour inputs, source keyframe statistics and
  // alpha, the edit tier (null without an edit file), and the edit file the playback chunks read (the measured one on the
  // edit route once written, V's on reuse_edit; null otherwise).
  plan: z.strictObject({
    route: z.enum(['encode', 'edit', 'reuse_edit', 'reuse']), stages: z.array(stage), toolInputId: hash.nullable(), planSha256: hash,
    content: videoPresentationPlanSchema, display: videoPresentationDisplaySchema,
    source: z.strictObject({ color: miniToolPlanColorInputsSchema, keyframes: sourceKeyframeStatsSchema, editTier: z.enum(EDIT_FILE_TIERS).nullable(), alpha: z.boolean() }),
    editStorageKey: storageKey.nullable(),
  }).nullable(),
  // The grid frame windows of the playback chunks, and of the edit file's chunks on the edit route (§5.4 chunking row).
  work: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('encode'), chunks: frameChunks }),
    z.strictObject({ kind: z.literal('edit'), editChunks: frameChunks, chunks: frameChunks }),
  ]),
  units: z.record(z.string().min(1), z.strictObject({
    state: z.enum(['none', 'open', 'done', 'failed']), attempt: index,
    attempts: z.array(z.strictObject({ attempt: attemptNumber, jobId: z.string().min(1), state: z.enum(['pending', 'done', 'failed']), usageRecorded: z.boolean() })),
    // The receipts of the attempt that completed a stitch unit, as the DO stored them.
    receipts: videoPresentationOutputReceiptsSchema.optional(),
  })),
  // Null only for a job this DO never admitted.
  // carrier and edit: the encode parameters frozen at admission, so every chunk of the job encodes alike (§5.4, §91 D3b-1).
  frozen: z.strictObject({ pricing: z.strictObject({ basic: videoPresentationPricingSchema, standard4: videoPresentationPricingSchema }), actorUserId: z.uuid(), projectId: z.uuid().nullable(),
    carrier: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema, maxShortSide: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
    edit: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }) }).nullable(),
}).superRefine((value, ctx) => {
  checkSelectedVideoPresentation(value, value.sourceBinding.sourceFingerprint, ctx);
  const { plan, work } = value;
  if (value.capability === null && plan !== null) ctx.addIssue({ code: 'custom', path: ['plan'], message: 'Only a granted job has a plan' });
  if (plan !== null && plan.stages.join() !== videoCarrierRouteStages(plan.route).join()) ctx.addIssue({ code: 'custom', path: ['plan', 'stages'], message: 'The stages are not the route\'s' });
  const kind = plan === null || plan.route === 'reuse' ? 'none' : plan.route === 'edit' ? 'edit' : 'encode';
  if (plan !== null && work.kind !== kind) ctx.addIssue({ code: 'custom', path: ['work'], message: 'The work does not belong to the route' });
  if (plan !== null && plan.route !== 'edit' && plan.toolInputId === null) ctx.addIssue({ code: 'custom', path: ['plan', 'toolInputId'], message: 'Only the edit route plans before its toolInputId is known' });
  if (plan !== null && plan.route === 'edit' && plan.source.editTier === null) ctx.addIssue({ code: 'custom', path: ['plan', 'source', 'editTier'], message: 'The edit route encodes at its edit tier' });
});
/** A parsed prepare answer. */
export type VideoPresentationPrepareAnswer = z.infer<typeof videoPresentationPrepareAnswerSchema>;

/**
 * Read a prepare answer across the trust boundary: the strict shape, then the plan content and the selected version's plan,
 * each adopted only when it is the plan its digest names (§3.2 item 6).
 * @param value - The unparsed answer.
 * @returns The validated answer.
 * @throws {z.ZodError} When the answer is malformed.
 * @throws {Error} When a plan is not the one its planSha256 names.
 */
export async function readVideoPresentationPrepareAnswer(value: unknown): Promise<VideoPresentationPrepareAnswer> {
  const answer = videoPresentationPrepareAnswerSchema.parse(value);
  if (answer.plan !== null) await verifyVideoPresentationPlan({ plan: answer.plan.content, planSha256: answer.plan.planSha256 });
  if (answer.presentation !== null) await verifyVideoPresentationPlan(answer.presentation);
  return answer;
}

/**
 * Read a snapshot across the trust boundary: the strict shape, then the selected version's plan, adopted only when it is the
 * plan its digest names (§3.2 item 6).
 * @param value - The unparsed snapshot.
 * @returns The validated snapshot.
 * @throws {z.ZodError} When the snapshot is malformed.
 * @throws {Error} When the selected version's plan is not the one its planSha256 names.
 */
export async function readVideoPresentationIngestSnapshot(value: unknown): Promise<VideoPresentationIngestSnapshot> {
  const snapshot = videoPresentationIngestSnapshotSchema.parse(value);
  if (snapshot.presentation !== null) await verifyVideoPresentationPlan(snapshot.presentation);
  return snapshot;
}

/**
 * The public URL of an object ingest writes or receives: the frozen public base joined to its key.
 * @param publicBaseURL - The https base without a trailing slash.
 * @param key - The storage key.
 * @returns The URL.
 * @throws {never} Never.
 */
export function videoPresentationObjectURL(publicBaseURL: string, key: string): string {
  return `${publicBaseURL}/${key}`;
}

/**
 * Post one request to the presentation route.
 * @param baseURL - Ingest base address.
 * @param secret - Shared backend credential.
 * @param request - The request.
 * @returns The unparsed answer.
 * @throws {Error} When ingest refuses.
 */
function askPresentation(baseURL: string, secret: string, request: VideoPresentationIngestRequest): Promise<unknown> {
  return askWorker<unknown>(`${baseURL}/video-presentation`, {
    method: 'POST', headers: { 'x-ingest-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(videoPresentationIngestRequestSchema.parse(request)),
  }, { replaySafe: true });
}

/**
 * Prepare (or re-read) one presentation job: the worker-only answer.
 * @param baseURL - Ingest base address.
 * @param secret - Shared backend credential.
 * @param request - The job identity.
 * @returns The validated answer.
 * @throws {Error} When ingest refuses, answers a malformed answer or a plan its digest does not name.
 */
export async function prepareVideoPresentationAtIngest(baseURL: string, secret: string, request: Extract<VideoPresentationIngestRequest, { action: 'prepare' }>): Promise<VideoPresentationPrepareAnswer> {
  return readVideoPresentationPrepareAnswer(await askPresentation(baseURL, secret, request));
}

/**
 * Submit one stage or unit event of a presentation job.
 * @param baseURL - Ingest base address.
 * @param secret - Shared backend credential.
 * @param request - The event.
 * @returns Whether the DO accepted it.
 * @throws {Error} When ingest refuses or answers malformed.
 */
export async function stepVideoPresentationAtIngest(baseURL: string, secret: string, request: Extract<VideoPresentationIngestRequest, { action: 'advance_stage' | 'report_chunk' }>): Promise<boolean> {
  return z.strictObject({ accepted: z.boolean() }).parse(await askPresentation(baseURL, secret, request)).accepted;
}

/**
 * Call the authenticated presentation auxiliary-work boundary.
 * @param baseURL - Ingest base address.
 * @param secret - Shared backend credential.
 * @param request - A replay-safe source and attempt operation.
 * @returns Durable admission and validated presentation facts.
 * @throws {Error} When ingest refuses, answers malformed source facts or a selected plan its digest does not name.
 */
export async function videoPresentationAtIngest(
  baseURL: string,
  secret: string,
  request: Exclude<VideoPresentationIngestRequest, { action: 'prepare' | 'advance_stage' | 'report_chunk' }>,
): Promise<VideoPresentationIngestSnapshot> {
  return readVideoPresentationIngestSnapshot(await askPresentation(baseURL, secret, request));
}
