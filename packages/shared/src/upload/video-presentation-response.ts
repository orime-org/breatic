// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';
import { alphaManifestMatchesPresentation, alphaManifestSchema, videoPresentationSchema, type AlphaManifest, type VideoPresentation } from '@shared/upload/video-presentation.js';
import { videoDurationsMatch } from '@shared/upload/video-duration.js';
import { videoPresentationTableReadLimitsSchema, type VideoPresentationTableReadLimits } from '@shared/upload/read-video-presentation-table.js';
import { videoSourceLedgerStateSchema } from '@shared/upload/video-source-ledger.js';
import type { VideoSourceLedgerState } from '@shared/upload/video-source-ledger-types.js';

/** Registry identity remains available before trusted media measurement. */
export interface VideoPresentationSourceBinding {
  assetId: string;
  contentHash: string;
  canonicalURL: string;
  kind: 'video';
  mediaInfo: { width: number | null; height: number | null; duration: number | null; mimeType: string };
}

/** Authorized source lookup and its independently resolved presentation. */
export interface VideoPresentationResponse {
  sourceBinding: VideoPresentationSourceBinding;
  presentation: VideoPresentation | null;
  manifest?: AlphaManifest;
  preparation: VideoPresentationPreparation | null;
  pollAfterMs: number | null;
  /** The source frame table's own capability state; absent from a server that predates it. */
  sourceLedger?: VideoSourceLedgerState;
  /** The current policy a reader holds the stored table to; absent means the table is not read. */
  sourceLedgerReadLimits?: VideoPresentationTableReadLimits;
}

/** Accepted independently funded metadata work, unchanged on replay. */
export interface VideoPresentationAttempt { jobId: string; deadlineAt: number }
/** A repair returns the fixed work identity as well as the current source facts. */
export interface VideoPresentationRepairResponse extends VideoPresentationResponse { attempt: VideoPresentationAttempt | null }
/** Auxiliary admission can exist before a valid measured descriptor exists. */
export interface VideoPresentationPreparation {
  status: 'accepted' | 'running' | 'completed' | 'failed';
  attempt: VideoPresentationAttempt;
  error?: string;
}

/** Registry-backed nullable metadata wire contract. */
export const videoPresentationSourceBindingSchema: z.ZodType<VideoPresentationSourceBinding> = z.strictObject({
  assetId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), canonicalURL: z.url(), kind: z.literal('video'),
  mediaInfo: z.strictObject({
    width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    duration: z.number().finite().positive().nullable(), mimeType: z.string().min(1),
  }),
});
const attempt = z.strictObject({ jobId: z.string().min(1), deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const preparation: z.ZodType<VideoPresentationPreparation> = z.strictObject({
  status: z.enum(['accepted', 'running', 'completed', 'failed']), attempt,
  error: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
}).superRefine((value, ctx) => {
  if ((value.status === 'failed') !== (value.error !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['error'], message: 'Only failed preparation carries its stable error code' });
  }
});
/** Authorized presentation query wire contract. */
export const videoPresentationResponseSchema: z.ZodType<VideoPresentationResponse> = z.strictObject({
  sourceBinding: videoPresentationSourceBindingSchema, presentation: videoPresentationSchema.nullable(),
  manifest: alphaManifestSchema.optional(), preparation: preparation.nullable(),
  pollAfterMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  sourceLedger: videoSourceLedgerStateSchema.optional(), sourceLedgerReadLimits: videoPresentationTableReadLimitsSchema.optional(),
}).superRefine((value, ctx) => {
  const ledger = value.sourceLedger;
  if (ledger !== undefined && ledger !== null &&
    (ledger.state === 'ready' ? ledger.receipt.sourceFingerprint : ledger.sourceFingerprint) !== value.sourceBinding.contentHash) {
    ctx.addIssue({ code: 'custom', path: ['sourceLedger'], message: 'Source ledger differs from registered source' });
  }
  const descriptor = value.presentation;
  if (descriptor !== null) {
    if (descriptor.sourceFingerprint !== value.sourceBinding.contentHash) {
      ctx.addIssue({ code: 'custom', path: ['presentation'], message: 'Presentation differs from registered source' });
    }
    for (const field of ['width', 'height', 'duration'] as const) {
      const known = value.sourceBinding.mediaInfo[field];
      if (known !== null && (field === 'duration' ? !videoDurationsMatch(known, descriptor.original.duration) : known !== descriptor.original[field])) {
        ctx.addIssue({ code: 'custom', path: ['presentation', 'original', field], message: 'Presentation differs from registered measurement' });
      }
    }
    if (descriptor.state === 'alpha_ready' && (value.manifest === undefined || !alphaManifestMatchesPresentation(value.manifest, descriptor))) {
      ctx.addIssue({ code: 'custom', path: ['manifest'], message: 'Ready alpha requires a matching verified manifest' });
    }
  }
  const pending = value.preparation?.status === 'accepted' || value.preparation?.status === 'running';
  if (pending !== (value.pollAfterMs !== null)) {
    ctx.addIssue({ code: 'custom', path: ['pollAfterMs'], message: 'Only accepted pending work carries a polling interval' });
  }
});

/** Repair uses the same validated source contract and one accepted work identity. */
export const videoPresentationRepairResponseSchema: z.ZodType<VideoPresentationRepairResponse> = z.object({ attempt: attempt.nullable() }).passthrough().transform((value) => {
  const { attempt: accepted, ...base } = value;
  return { ...videoPresentationResponseSchema.parse(base), attempt: accepted };
});
