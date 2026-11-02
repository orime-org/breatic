// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ContainerUsage } from '@shared/upload/mini-tool-job.js';
import { z } from 'zod';
import { videoPresentationOriginalSchema } from '@shared/upload/video-presentation.js';
import {
  videoPresentationLedgerReceiptSchema, videoPresentationVersionSchema, type VideoPresentationLedgerReceipt, type VideoPresentationVersion,
} from '@shared/upload/video-presentation-version.js';
import type { VideoCarrierStage } from '@shared/mini-tools/video-encode-plan.js';
import { askWorker } from '@shared/upload/ingest-client.js';
import { untilDeadline } from '@shared/http/deadline.js';
import type { VideoPresentation } from '@shared/upload/video-presentation-types.js';
import type { VideoPresentationProcessLimits, VideoPresentationRegisteredMetadata } from '@shared/upload/video-presentation-types.js';
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

/** Both container prices, frozen together at admission (design §3.5): basic probes and copies, standard-4 encodes. */
export interface VideoPresentationIngestPricing { basic: VideoPresentationPricing; standard4: VideoPresentationPricing }
/** The retry caps frozen at admission. */
export interface VideoPresentationAdmissionPolicy { chunkRetries: number; maxAutoRepairs: number }
/** The internal source binding: the registered storage key and the source bytes' fingerprint. */
export interface VideoPresentationIngestSourceBinding { storageKey: string; sourceFingerprint: string }
/** The target policy's preparation: the original job, its real stage and its failure code. */
export interface VideoPresentationIngestPreparation {
  targetPolicyVersion: number;
  jobId: string;
  stage: VideoCarrierStage | null;
  failure: string | null;
}
/** The selected version's companion state; absent is null, a failure carries its code. */
export type VideoPresentationIngestLedger =
  | { state: 'pending'; receipt: null; failure: null }
  | { state: 'ready'; receipt: VideoPresentationLedgerReceipt; failure: null }
  | { state: 'failed'; receipt: null; failure: string };
/** A read: the selected bundle, the target policy's preparation and the selected version's ledger, never a full array (§3.5, §5.1 step 6). */
export interface VideoPresentationIngestSnapshot {
  sourceBinding: VideoPresentationIngestSourceBinding;
  presentation: VideoPresentationVersion | null;
  preparation: VideoPresentationIngestPreparation | null;
  ledger: VideoPresentationIngestLedger | null;
  usageFact?: VideoPresentationUsageFact;
}
/** Plain internal calls; only ingest owns storage and container execution. */
export type VideoPresentationIngestRequest = {
  action: 'read' | 'accept' | 'run' | 'expire' | 'ack_usage';
  storageKey: string;
  sourceFingerprint: string;
  jobId?: string;
  deadlineAt?: number;
  original?: VideoPresentation['original'] | null;
  registeredMetadata?: VideoPresentationRegisteredMetadata;
  contentType?: string;
  knownAlpha?: boolean;
  repair?: boolean;
  limits?: VideoPresentationProcessLimits;
  pricing?: VideoPresentationIngestPricing;
  /** The target presentation policy; every admission and read carries it. */
  targetPolicyVersion?: number;
  policy?: VideoPresentationAdmissionPolicy;
  actorUserId?: string;
  projectId?: string | null;
  packedURL?: string;
  manifestURL?: string;
  /** Public address of the full source ledger; sent with `sourceLedgerTableURL` and `limits.sourceLedger`, or not at all. */
  sourceLedgerURL?: string;
  /** Public address of the compact presentation table written with the ledger. */
  sourceLedgerTableURL?: string;
};

const usage = z.strictObject({ wallMs: z.number().finite().nonnegative(), cpuUsec: z.number().finite().nonnegative().nullable() });
export const videoPresentationPricingSchema: z.ZodType<VideoPresentationPricing> = z.strictObject({
  containerClass: z.string().min(1),
  size: z.strictObject({ vcpu: z.number().positive(), memory_gib: z.number().positive(), disk_gb: z.number().positive() }),
  prices: z.strictObject({ vcpu_second_usd: z.number().nonnegative(), memory_gib_second_usd: z.number().nonnegative(), disk_gb_second_usd: z.number().nonnegative() }),
});
const retryCap = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const budget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const httpsUrl = z.url().refine(value => value.startsWith('https://'));
/** Limits are validated at the edge and frozen for the original accepted job; the ledger has byte and parser budgets, never a frame count ceiling. */
export const videoPresentationProcessLimitsSchema: z.ZodType<VideoPresentationProcessLimits> = z.strictObject({
  sourceLedger: z.strictObject({
    maxBytes: budget, probeStdoutBytes: budget, metadataBytes: budget, isoBoxCount: budget, matroskaElementCount: budget, matroskaMaxBlocks: budget,
  }).optional(),
  maxSourceBytes: z.number().int().positive(), maxPackedBytes: z.number().int().positive(),
  crf: z.number().int().min(0).max(51), preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']),
  probeStdoutBytes: z.number().int().positive(), analysisStdoutBytes: z.number().int().positive(), stderrTailBytes: z.number().int().positive(),
});
/** The backend-only operation contract contains no client classification claim. */
export const videoPresentationIngestRequestSchema: z.ZodType<VideoPresentationIngestRequest> = z.strictObject({
  action: z.enum(['read', 'accept', 'run', 'expire', 'ack_usage']), storageKey: z.string().min(1).max(500), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: z.string().min(1).max(200).optional(), deadlineAt: z.number().int().positive().optional(),
  original: videoPresentationOriginalSchema.nullable().optional(),
  registeredMetadata: z.strictObject({ width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(), duration: z.number().finite().positive().nullable() }).optional(),
  contentType: z.string().min(1).optional(), knownAlpha: z.boolean().optional(), repair: z.boolean().optional(),
  limits: videoPresentationProcessLimitsSchema.optional(),
  pricing: z.strictObject({ basic: videoPresentationPricingSchema, standard4: videoPresentationPricingSchema }).optional(),
  targetPolicyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  policy: z.strictObject({ chunkRetries: retryCap, maxAutoRepairs: retryCap }).optional(),
  actorUserId: z.uuid().optional(),
  projectId: z.uuid().nullable().optional(), packedURL: z.url().optional(), manifestURL: z.url().optional(),
  sourceLedgerURL: httpsUrl.optional(), sourceLedgerTableURL: httpsUrl.optional(),
}).superRefine((value, ctx) => {
  const ledgerParts = [value.limits?.sourceLedger, value.sourceLedgerURL, value.sourceLedgerTableURL].filter(part => part !== undefined).length;
  if (ledgerParts !== 0 && ledgerParts !== 3) ctx.addIssue({ code: 'custom', message: 'A ledger request carries its budgets and both object addresses together' });
  if (value.sourceLedgerURL !== undefined && value.sourceLedgerURL === value.sourceLedgerTableURL) ctx.addIssue({ code: 'custom', message: 'The ledger and its table are different objects' });
  if (value.action !== 'read' && (value.jobId === undefined || value.deadlineAt === undefined)) ctx.addIssue({ code: 'custom', message: 'Attempt operations require their fixed identity' });
  if ((value.action === 'read' || value.action === 'accept') && value.targetPolicyVersion === undefined) ctx.addIssue({ code: 'custom', message: 'Admission and read carry the target policy' });
  if (value.action === 'accept' && (value.original === undefined || value.contentType === undefined || value.limits === undefined || value.pricing === undefined || value.policy === undefined || value.actorUserId === undefined || value.projectId === undefined || value.packedURL === undefined || value.manifestURL === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Admission requires frozen source facts, pricing, attribution and capabilities' });
  }
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const errorCode = z.string().regex(/^[a-z][a-z0-9_]*$/);
const ledger = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('pending'), receipt: z.null(), failure: z.null() }),
  z.strictObject({ state: z.literal('ready'), receipt: videoPresentationLedgerReceiptSchema, failure: z.null() }),
  z.strictObject({ state: z.literal('failed'), receipt: z.null(), failure: errorCode }),
]);
/** Internal response parser is shared by the backend client and ingest writer. */
export const videoPresentationIngestSnapshotSchema: z.ZodType<VideoPresentationIngestSnapshot> = z.strictObject({
  sourceBinding: z.strictObject({ storageKey: z.string().min(1).max(500), sourceFingerprint: hash }),
  presentation: videoPresentationVersionSchema.nullable(),
  preparation: z.strictObject({
    targetPolicyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), jobId: z.string().min(1),
    stage: z.enum(['plan', 'copy', 'dispatch_copy', 'encode', 'stitch', 'publish']).nullable(), failure: errorCode.nullable(),
  }).nullable(),
  ledger: ledger.nullable(),
  usageFact: z.strictObject({ jobId: z.string().min(1), actorUserId: z.uuid(), projectId: z.uuid().nullable(), usage, pricing: videoPresentationPricingSchema }).optional(),
}).superRefine((value, ctx) => {
  const { presentation, ledger: state } = value;
  if (presentation !== null && presentation.sourceFingerprint !== value.sourceBinding.sourceFingerprint) {
    ctx.addIssue({ code: 'custom', path: ['presentation'], message: 'The selected bundle belongs to another source' });
  }
  if (state === null) return;
  if (presentation === null) ctx.addIssue({ code: 'custom', path: ['ledger'], message: 'Only a selected version reports its ledger' });
  else if (state.receipt !== null && (state.receipt.toolInputId !== presentation.toolInputId || state.receipt.sourceFingerprint !== presentation.sourceFingerprint)) {
    ctx.addIssue({ code: 'custom', path: ['ledger'], message: 'The ledger receipt belongs to another tool input' });
  }
});

/**
 * Call the authenticated presentation auxiliary-work boundary.
 * @param baseURL - Ingest base address.
 * @param secret - Shared backend credential.
 * @param request - A replay-safe source and attempt operation.
 * @returns Durable admission and validated presentation facts.
 * @throws {Error} When ingest refuses or answers malformed source facts.
 */
export async function videoPresentationAtIngest(
  baseURL: string,
  secret: string,
  request: VideoPresentationIngestRequest,
): Promise<VideoPresentationIngestSnapshot> {
  const answered = await askWorker<unknown>(`${baseURL}/video-presentation`, {
    method: 'POST', headers: { 'x-ingest-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(request),
  }, { replaySafe: true, ...(request.action === 'run' && request.deadlineAt !== undefined ? { bound: untilDeadline(request.deadlineAt) } : {}) });
  return videoPresentationIngestSnapshotSchema.parse(answered);
}
