// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoSourceLedgerState } from '@shared/upload/video-source-ledger-types.js';

import type { VideoPresentation, AlphaManifest } from '@shared/upload/video-presentation.js';
import type { ContainerUsage } from '@shared/upload/mini-tool-job.js';
import { z } from 'zod';
import { alphaManifestSchema, videoPresentationOriginalSchema, videoPresentationSchema } from '@shared/upload/video-presentation.js';
import { askWorker } from '@shared/upload/ingest-client.js';
import { videoSourceLedgerStateSchema } from '@shared/upload/video-source-ledger.js';
import { untilDeadline } from '@shared/http/deadline.js';
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

/** Internal durable admission, including work accepted before media measurement. */
export interface VideoPresentationIngestAttempt {
  jobId: string;
  deadlineAt: number;
  status: 'accepted' | 'running' | 'completed' | 'failed';
  usage: ContainerUsage | null;
  error?: string;
  usageRecorded?: boolean;
}
/** A read never infers native from missing sidecars. */
export interface VideoPresentationIngestSnapshot {
  sourceLedger?: VideoSourceLedgerState;
  presentation: VideoPresentation | null;
  manifest?: AlphaManifest;
  attempt: VideoPresentationIngestAttempt | null;
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
  pricing?: VideoPresentationPricing;
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
  limits: videoPresentationProcessLimitsSchema.optional(), pricing: videoPresentationPricingSchema.optional(), actorUserId: z.uuid().optional(),
  projectId: z.uuid().nullable().optional(), packedURL: z.url().optional(), manifestURL: z.url().optional(),
  sourceLedgerURL: httpsUrl.optional(), sourceLedgerTableURL: httpsUrl.optional(),
}).superRefine((value, ctx) => {
  const ledgerParts = [value.limits?.sourceLedger, value.sourceLedgerURL, value.sourceLedgerTableURL].filter(part => part !== undefined).length;
  if (ledgerParts !== 0 && ledgerParts !== 3) ctx.addIssue({ code: 'custom', message: 'A ledger request carries its budgets and both object addresses together' });
  if (value.sourceLedgerURL !== undefined && value.sourceLedgerURL === value.sourceLedgerTableURL) ctx.addIssue({ code: 'custom', message: 'The ledger and its table are different objects' });
  if (value.action !== 'read' && (value.jobId === undefined || value.deadlineAt === undefined)) ctx.addIssue({ code: 'custom', message: 'Attempt operations require their fixed identity' });
  if (value.action === 'accept' && (value.original === undefined || value.contentType === undefined || value.limits === undefined || value.pricing === undefined || value.actorUserId === undefined || value.projectId === undefined || value.packedURL === undefined || value.manifestURL === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Admission requires frozen source facts, pricing, attribution and capabilities' });
  }
});
/** Internal response parser is shared by the backend client and ingest writer. */
export const videoPresentationIngestSnapshotSchema: z.ZodType<VideoPresentationIngestSnapshot> = z.strictObject({
  presentation: videoPresentationSchema.nullable(), manifest: alphaManifestSchema.optional(),
  attempt: z.strictObject({ jobId: z.string().min(1), deadlineAt: z.number().int().positive(),
    status: z.enum(['accepted', 'running', 'completed', 'failed']), usage: usage.nullable(),
    error: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(), usageRecorded: z.boolean().optional(),
  }).nullable(),
  usageFact: z.strictObject({ jobId: z.string().min(1), actorUserId: z.uuid(), projectId: z.uuid().nullable(), usage, pricing: videoPresentationPricingSchema }).optional(),
  sourceLedger: videoSourceLedgerStateSchema.optional(),
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
