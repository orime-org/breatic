// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoPresentation, AlphaManifest } from '@shared/upload/video-presentation.js';
import type { ContainerUsage } from '@shared/upload/mini-tool-job.js';

/** Internal durable admission, including work accepted before media measurement. */
export interface VideoPresentationIngestAttempt {
  jobId: string;
  deadlineAt: number;
  status: 'accepted' | 'running' | 'completed' | 'failed';
  usage: ContainerUsage | null;
  error?: string;
}
/** A read never infers native from missing sidecars. */
export interface VideoPresentationIngestSnapshot {
  presentation: VideoPresentation | null;
  manifest?: AlphaManifest;
  attempt: VideoPresentationIngestAttempt | null;
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
};

/**
 * Call the authenticated presentation auxiliary-work boundary.
 * @param baseURL - Ingest base address.
 * @param secret - Shared backend credential.
 * @param request - A replay-safe source and attempt operation.
 * @returns Durable admission and validated presentation facts.
 * @throws {Error} Until the independently specified implementation replaces this RED stub.
 */
export async function videoPresentationAtIngest(
  baseURL: string,
  secret: string,
  request: VideoPresentationIngestRequest,
): Promise<VideoPresentationIngestSnapshot> {
  void baseURL;
  void secret;
  void request;
  throw new Error('Video presentation ingest client is not implemented');
}
