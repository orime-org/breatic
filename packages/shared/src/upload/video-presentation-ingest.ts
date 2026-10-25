// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoPresentation, AlphaManifest } from '@shared/upload/video-presentation.js';
import type { ContainerUsage } from '@shared/upload/mini-tool-job.js';
import { z } from 'zod';
import { alphaManifestSchema, videoPresentationSchema } from '@shared/upload/video-presentation.js';
import { askWorker } from '@shared/upload/ingest-client.js';
import { untilDeadline } from '@shared/http/deadline.js';

/** Frozen operational and subprocess ceilings for one auxiliary attempt. */
export interface VideoPresentationProcessLimits {
  maxSourceBytes: number;
  maxPackedBytes: number;
  crf: number;
  preset: string;
  probeStdoutBytes: number;
  analysisStdoutBytes: number;
  stderrTailBytes: number;
}
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
  presentation: VideoPresentation | null;
  manifest?: AlphaManifest;
  attempt: VideoPresentationIngestAttempt | null;
  usageFact?: VideoPresentationUsageFact;
}
/** Plain internal calls; only ingest owns storage and container execution. */
export type VideoPresentationIngestRequest = {
  action: 'read' | 'accept' | 'run' | 'ack_usage';
  storageKey: string;
  sourceFingerprint: string;
  jobId?: string;
  deadlineAt?: number;
  original?: VideoPresentation['original'] | null;
  contentType?: string;
  knownAlpha?: boolean;
  repair?: boolean;
  limits?: VideoPresentationProcessLimits;
  pricing?: VideoPresentationPricing;
  actorUserId?: string;
  projectId?: string | null;
  packedURL?: string;
  manifestURL?: string;
};

const usage = z.strictObject({ wallMs: z.number().finite().nonnegative(), cpuUsec: z.number().finite().nonnegative().nullable() });
const pricing: z.ZodType<VideoPresentationPricing> = z.strictObject({
  containerClass: z.string().min(1),
  size: z.strictObject({ vcpu: z.number().positive(), memory_gib: z.number().positive(), disk_gb: z.number().positive() }),
  prices: z.strictObject({ vcpu_second_usd: z.number().nonnegative(), memory_gib_second_usd: z.number().nonnegative(), disk_gb_second_usd: z.number().nonnegative() }),
});
/** Internal response parser is shared by the backend client and ingest writer. */
export const videoPresentationIngestSnapshotSchema: z.ZodType<VideoPresentationIngestSnapshot> = z.strictObject({
  presentation: videoPresentationSchema.nullable(), manifest: alphaManifestSchema.optional(),
  attempt: z.strictObject({ jobId: z.string().min(1), deadlineAt: z.number().int().positive(),
    status: z.enum(['accepted', 'running', 'completed', 'failed']), usage: usage.nullable(),
    error: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(), usageRecorded: z.boolean().optional(),
  }).nullable(),
  usageFact: z.strictObject({ jobId: z.string().min(1), actorUserId: z.uuid(), projectId: z.uuid().nullable(), usage, pricing }).optional(),
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
