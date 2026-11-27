// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from 'zod';
import { videoDurationsMatch } from '@shared/upload/video-duration.js';
import { videoPresentationVersionSchema, type VideoPresentationVersion } from '@shared/upload/video-presentation-version.js';
import {
  checkSelectedVideoPresentation, videoPresentationIngestPreparationSchema, type VideoPresentationIngestPreparation,
} from '@shared/upload/video-presentation-ingest.js';

/** Registry identity remains available before trusted media measurement. */
export interface VideoPresentationSourceBinding {
  assetId: string;
  contentHash: string;
  canonicalURL: string;
  kind: 'video';
  mediaInfo: { width: number | null; height: number | null; duration: number | null; mimeType: string };
}

/**
 * Authorized source lookup and its presentation (design §3.5 web→server row): the selected bundle, the target policy's
 * preparation; a repair answers the same response.
 */
export interface VideoPresentationResponse {
  sourceBinding: VideoPresentationSourceBinding;
  presentation: VideoPresentationVersion | null;
  preparation: VideoPresentationIngestPreparation | null;
  /** The registered video's cover image, which a surface shows while its picture is not drawn; null when it has none. */
  coverURL: string | null;
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
/** Authorized presentation query and repair wire contract. */
export const videoPresentationResponseSchema: z.ZodType<VideoPresentationResponse> = z.strictObject({
  sourceBinding: videoPresentationSourceBindingSchema, presentation: videoPresentationVersionSchema.nullable(),
  preparation: videoPresentationIngestPreparationSchema.nullable(),
  coverURL: z.url().nullable(),
}).superRefine((value, ctx) => {
  checkSelectedVideoPresentation(value, value.sourceBinding.contentHash, ctx);
  const descriptor = value.presentation;
  if (descriptor !== null) {
    for (const field of ['width', 'height', 'duration'] as const) {
      const known = value.sourceBinding.mediaInfo[field];
      const measured = descriptor.original[field];
      if (known !== null && (measured === null || (field === 'duration' ? !videoDurationsMatch(measured, known) : known !== measured))) {
        ctx.addIssue({ code: 'custom', path: ['presentation', 'original', field], message: 'Presentation differs from registered measurement' });
      }
    }
  }
});
