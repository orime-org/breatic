// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The presentation run's path and shapes without a validator (inner#1306 test plan §91 D-3): the media container
 * bundles only this repository's code, so it reads these; the DO side validates them in `presentation-run-contract.ts`.
 */

import type { VideoCarrierRouteInput, VideoEncoderRates, VideoJobWork } from '@shared/mini-tools/video-encode-plan.js';
import type { VideoPresentationProcessLimits } from '@shared/upload/video-presentation-types.js';
import type { VideoSourceLedgerProcessLimits } from '@shared/upload/video-source-ledger-types.js';

/** One container path for all three actions (probe now; ledger and carrier with D2). */
export const PRESENTATION_RUN_PATH = '/presentation';

/** One identity combination (design §4.1), as the accept freezes it. */
export interface PresentationIdentityFormat {
  container: string; videoCodec: string; profiles: string[]; pixFmt: string; bitDepth: number; audioCodecs: string[];
  rotation: 0; sar: '1:1'; matrixTagged: true;
}
/** The probe facts frozen at admission. */
export interface PresentationProbeFacts { sampleFrames: number; singleFrameDurationMs: number; identityFormats: PresentationIdentityFormat[] }
/** The encoding policy frozen at admission. */
export interface PresentationRunEncoding {
  chunkShare: number; maxParallelChunks: number; encoder: VideoEncoderRates; copyDiskMarginBytes: number;
  carrier: { maxShortSide: number; color: { primaries: string; transfer: string; matrix: string; range: string } };
}
/** The probe action: the source and every frozen fact it needs; nothing from an earlier call. */
export interface PresentationProbeRequest {
  action: 'probe'; jobId: string; sourceFingerprint: string; deadlineAt: number; sourceURL: string;
  limits: VideoPresentationProcessLimits & { sourceLedger: VideoSourceLedgerProcessLimits };
  encoding: PresentationRunEncoding; probe: PresentationProbeFacts;
}
/** The route facts the probe can know; the DO adds the selected version, the copy margin and the basic disk. */
export type PresentationProbeRoute = Omit<VideoCarrierRouteInput, 'selected' | 'copyDiskMarginBytes' | 'basicDiskBytes'>;
/** The probe's answer: the plan with its identities and the facts beside it, or a stable failure code. */
export type PresentationProbeAnswer =
  | {
    kind: 'planned'; toolInputId: string; planSha256: string; plan: object;
    encoding: { keyframeOrdinals: number[]; codedWidth: number; codedHeight: number };
    routeInput: PresentationProbeRoute; work: VideoJobWork;
  }
  | { kind: 'failed'; code: string };
