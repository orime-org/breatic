// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The presentation run's path and shapes without a validator (inner#1306 test plan §91 D-3): the media container
 * bundles only this repository's code, so it reads these; the DO side validates them in `presentation-run-contract.ts`.
 */

import type { VideoCarrierRouteInput, VideoEncoderRates, VideoJobWork } from '@shared/mini-tools/video-encode-plan.js';
import type { PresentationRational } from '@shared/mini-tools/video-presentation-projection.js';
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
/** What the ledger and carrier actions add: the capability token the edge authorizes with and the canonical key. */
export interface PresentationWriterFields { token: string; storageKey: string }
/** The full ledger's encode facts (§3.2 item 7): keyframe ordinals, coded size, every source keyframe and the first packet dts. */
export interface PresentationEncodeFacts {
  keyframeOrdinals: number[]; codedWidth: number; codedHeight: number;
  sourceKeyframes: { pts: PresentationRational; dts: PresentationRational }[]; firstPacketDts: PresentationRational;
}
/** The ledger action: write full and compact for the toolInputId; a null encodeFacts is a ledger-only repair. */
export type PresentationLedgerRequest = Omit<PresentationProbeRequest, 'action'> & PresentationWriterFields & {
  action: 'ledger'; toolInputId: string; encodeFacts: PresentationEncodeFacts | null;
};
/** The carrier action: identity or the basic copy; the identity receipt takes the registered content type. */
export type PresentationCarrierRequest = Omit<PresentationProbeRequest, 'action'> & PresentationWriterFields & {
  action: 'carrier'; route: 'identity' | 'copy'; contentType: string;
};
/** Any run request. */
export type PresentationRunBody = PresentationProbeRequest | PresentationLedgerRequest | PresentationCarrierRequest;
/** One role-tagged carrier receipt as the Worker measured it. */
export interface PresentationCarrierReceipt { role: 'carrier'; packing: 'native'; storageKey: string; sha256: string; sizeBytes: number; contentType: string }
/** The ledger action's answer. */
export type PresentationLedgerAnswer = { kind: 'written' } | { kind: 'failed'; code: string };
/** The carrier action's answer. */
export type PresentationCarrierAnswer = { kind: 'carrier'; receipts: PresentationCarrierReceipt[] } | { kind: 'failed'; code: string };
/** The outbound hosts the container writes through. */
export const SOURCE_LEDGER_WRITE_HOST = 'source-ledger.local';
export const PRESENTATION_CARRIER_HOST = 'presentation-carrier.local';
/** The outbound handlers the source ledger and carrier hosts map to. */
export const SOURCE_LEDGER_HANDLER = 'writeSourceLedgerPresentation';
export const PRESENTATION_CARRIER_HANDLER = 'writePresentationCarrier';

/** The route facts the probe can know; the DO adds the selected version, the copy margin and the basic disk. */
export type PresentationProbeRoute = Omit<VideoCarrierRouteInput, 'selected' | 'copyDiskMarginBytes' | 'basicDiskBytes'>;
/** The probe's answer: the plan with its identities and the facts beside it, or a stable failure code. */
export type PresentationProbeAnswer =
  | {
    kind: 'planned'; toolInputId: string; planSha256: string; plan: object;
    encoding: PresentationEncodeFacts;
    routeInput: PresentationProbeRoute; work: VideoJobWork & { audioSeconds: number };
  }
  | { kind: 'failed'; code: string };
