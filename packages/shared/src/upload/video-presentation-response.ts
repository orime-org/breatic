// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';
import type { AlphaManifest, VideoPresentation } from '@shared/upload/video-presentation.js';

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
}

/** Accepted independently funded metadata work, unchanged on replay. */
export interface VideoPresentationAttempt { jobId: string; deadlineAt: number }
/** Auxiliary admission can exist before a valid measured descriptor exists. */
export interface VideoPresentationPreparation {
  status: 'accepted' | 'running' | 'completed' | 'failed';
  attempt: VideoPresentationAttempt;
  error?: string;
}

/** Registry-backed nullable metadata wire contract. */
export const videoPresentationSourceBindingSchema = z.never() as unknown as z.ZodType<VideoPresentationSourceBinding>;
/** Authorized presentation query wire contract. */
export const videoPresentationResponseSchema = z.never() as unknown as z.ZodType<VideoPresentationResponse>;
