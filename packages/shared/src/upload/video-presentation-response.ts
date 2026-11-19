// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
  pollAfterMs: number | null;
}

/**
 * Whether the user's view waits on server work (§7.12): nothing selected while the target work has not failed. A
 * selected version is complete, its grid inside it. The one rule behind `pollAfterMs` on both sides.
 * @param value - The selected bundle and the preparation.
 * @param value.presentation - The selected bundle, or null.
 * @param value.preparation - The target policy's preparation, or null.
 * @returns True while a later read can change what the user sees.
 * @throws {never} Never.
 */
export function videoPresentationAwaitsServer(value: { presentation: VideoPresentationVersion | null; preparation: VideoPresentationIngestPreparation | null }): boolean {
  return value.presentation === null && value.preparation !== null && value.preparation.failure === null;
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
  pollAfterMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
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
  if (videoPresentationAwaitsServer(value) !== (value.pollAfterMs !== null)) {
    ctx.addIssue({ code: 'custom', path: ['pollAfterMs'], message: 'Only a reader waiting on server work carries a polling interval' });
  }
});
