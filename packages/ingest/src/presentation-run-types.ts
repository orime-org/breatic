// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The presentation probe's path and shapes without a validator (frames-split design §5.1 step 2): the media container bundles
 * only this repository's code, so it reads these; the DO side validates them in `presentation-run-contract.ts`.
 */

import type { EditFileTier } from '@shared/mini-tools/video-encode-plan.js';
import type { FrameRate, SourceDecodeKey } from '@shared/upload/frame-grid-rate.js';
import type { FrameGrid, SourceKeyframeStats } from '@shared/upload/frame-grid.js';
import type { MiniToolPlanColorInputs } from '@shared/upload/mini-tool-plan-types.js';
import type { VideoPresentationProcessLimits } from '@shared/upload/video-presentation-types.js';

/** The one container path of the presentation probe. */
export const PRESENTATION_RUN_PATH = '/presentation';

/** The probe facts frozen at admission (§5.1 step 2, §4.1). */
export interface PresentationProbeFacts { sampleFrames: number; singleFrameDurationMs: number; maxFps: number }
/** The encoding policy frozen at admission, as far as the probe reads it. */
export interface PresentationRunEncoding {
  chunkShare: number; maxParallelChunks: number;
  encoder: {
    startSeconds: number; encodePixelsPerSecond: number; tonemapPixelsPerSecond: number; decodeConvertPixelsPerSecond: Record<string, number>;
    editEncodePixelsPerSecond: Record<string, number>; aacEncodeSecondsPerSecond: number;
  };
  edit: { crf: number; preset: string; proresProfile: string; bytesPerPixel: number; maxEditBytes: number };
  carrier: { maxShortSide: number; color: { primaries: string; transfer: string; matrix: string; range: string } };
}
/** The probe action: the source and every frozen fact it needs. */
export interface PresentationProbeRequest {
  action: 'probe'; jobId: string; sourceFingerprint: string; deadlineAt: number; sourceURL: string;
  limits: VideoPresentationProcessLimits; encoding: PresentationRunEncoding; probe: PresentationProbeFacts;
}
/** Any run request. */
export type PresentationRunBody = PresentationProbeRequest;

/** The inputs of the grid plan the probe read; the decode-only count adds the last frame's time and the frame count (§4.1). */
export interface PresentationGridInput {
  fps: FrameRate; firstVideoTime: FrameRate; firstAudioFrameTime: FrameRate | null; audioEnd: FrameRate | null; quantum: FrameRate;
}
/** The tool-source facts the probe read (§3.2 item 7, §4.2, §5.4). */
export interface PresentationSourceFacts {
  sourceDecodeKey: SourceDecodeKey; keyframes: SourceKeyframeStats; hdr: boolean; alpha: boolean; editTier: EditFileTier | null; bitDepth: number;
  /** Whether FFmpeg seeks in the original (§4.2); an unseekable one's edit file is one whole job, never chunked (§5.4 limit row). */
  seekable: boolean;
  /** The explicit colour inputs an edit chunk reads (§4.3 colour/HDR row). */
  color: MiniToolPlanColorInputs;
}
/** The probe's answer: the plan, its digest and versions, the tool-source facts and the grid inputs, or a stable failure code. */
export type PresentationProbeAnswer =
  | {
    kind: 'planned'; plan: object; planSha256: string;
    versions: { producerVersion: string; profileVersion: string; editProfileVersion: string | null };
    source: PresentationSourceFacts;
    gridInput: PresentationGridInput;
    /** The grid from the packet scan, before the count: the last presented packet's time and the presented packets. */
    estimate: { lastVideoTime: FrameRate; sourceFrames: number } & Pick<FrameGrid, 'frameCount' | 'realFrameCount'>;
    sourceBytes: number;
  }
  | { kind: 'failed'; code: string };
