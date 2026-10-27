// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Exact owned seconds, reduced with a positive denominator. */
export interface ExactPresentationTime { numerator: string; denominator: string }
/** One actual physical frame in its original decoder clock. */
export interface PhysicalVideoFrame { rawDecodeOrdinal: number; ptsTicks: string }
/** A declared edit interval may be empty or have zero width. */
export interface OwnedEditInterval { editOccurrence: number; empty: boolean; start: ExactPresentationTime; end: ExactPresentationTime }
/** A physical picture may have several independent legal presentation occurrences. */
export interface OwnedPresentationOccurrence {
  presentationOrdinal: number;
  editOccurrence: number;
  rawDecodeOrdinal: number;
  sourcePtsTicks: string;
  mappedPts: ExactPresentationTime;
  displayStart: ExactPresentationTime;
  displayEnd: ExactPresentationTime;
}
/** Owned exact schedule, independent of native playback equivalence. */
export interface OwnedVideoPresentation { edits: OwnedEditInterval[]; frames: OwnedPresentationOccurrence[] }
/** Original signed fixed-point rate and exact ISO edit fields. */
export interface IsoBmffEdit { segmentDurationMovieTicks: string; mediaTimeTrackTicks: string; mediaRateFixed16_16: string }
/** Compressed original unsigned decode timing. */
export interface IsoBmffDecodeRun { sampleCount: number; deltaTicks: string }
/** Versioned original composition timing. */
export interface IsoBmffCompositionRun { sampleCount: number; offsetTicks: string }
/** The five original signed composition-shift fields. */
export interface IsoBmffCompositionShift {
  version: 0 | 1;
  compositionToDtsShift: string;
  leastDecodeToDisplayDelta: string;
  greatestDecodeToDisplayDelta: string;
  compositionStartTime: string;
  compositionEndTime: string;
}
/** Complete declared selected-track sample timing, when physically present. */
export interface IsoBmffSampleTiming {
  decodeRuns: IsoBmffDecodeRun[];
  cttsVersion: 0 | 1 | null;
  compositionRuns: IsoBmffCompositionRun[] | null;
  compositionShift: IsoBmffCompositionShift | null;
}
/** Original selected ISO track without a synthetic edit list. */
export interface IsoBmffTrackMetadata {
  trackId: number;
  trackFlags: number;
  durationMovieTicks: string;
  mediaTimescale: string;
  mediaDurationTicks: string;
  edits: IsoBmffEdit[] | null;
  sampleTiming?: IsoBmffSampleTiming;
}
/** Exact original ISO physical facts. */
export interface PhysicalVideoProbe {
  streamIndex: number;
  trackId: number;
  sourceTimeBase: { numerator: string; denominator: string };
  frames: { rawDecodeOrdinal: number; ptsTicks: string }[];
}
/** Exact rational value of the original IEEE track-scale representation. */
export interface MatroskaTrackScale { numerator: string; denominator: string }
/** Original selected Matroska track and its effective normative defaults. */
export interface MatroskaTrackMetadata {
  trackNumber: string;
  trackUid: string;
  trackType: string;
  codecId: string;
  enabled: boolean;
  defaultDurationNs: string | null;
  trackTimestampScale: MatroskaTrackScale;
  codecDelayNs: string;
}
/** Original selected block; its ordinal remains global across unselected tracks. */
export interface MatroskaBlockMetadata {
  blockOrdinal: number;
  kind: 'simple' | 'group';
  elementOffset: string;
  dataOffset: string;
  dataBytes: string;
  trackNumber: string;
  clusterTimestampTicks: string;
  relativeTimestampTicks: string;
  invisible: boolean;
  lacing: 'none' | 'xiph' | 'fixed' | 'ebml';
  frameCount: number;
  blockDurationTicks: string | null;
  discardPaddingNs: string | null;
}
/** Original physical Matroska picture identities and their actual block association. */
export interface MatroskaPhysicalVideoProbe {
  streamIndex: number;
  trackNumber: string;
  trackUid: string;
  sourceTimeBase: { numerator: string; denominator: string };
  frames: { rawDecodeOrdinal: number; ptsTicks: string; blockOrdinal: number }[];
}
/** The existing accepted platform preparation identity. */
export interface VideoSourceLedgerAttempt { jobId: string; deadlineAt: number }
/** Only source strategies independently supported by the original producer. */
export type VideoSourceLedgerStrategy = 'iso_explicit_rate_one' | 'iso_unedited_rate_one' | 'matroska_rate_one';
/** Small measured companion receipt; it is not the validated full frame table. */
export interface VideoSourceLedgerReceipt {
  schemaVersion: 1;
  sourceFingerprint: string;
  producerVersion: 1;
  strategy: VideoSourceLedgerStrategy;
  attempt: VideoSourceLedgerAttempt;
  url: string;
  etag: string;
  size: number;
  sha256: string;
  contentType: 'application/json';
  physicalFrameCount: number;
  occurrenceCount: number;
}
/** Shared immutable source facts, distinct from runtime storage or native clocks. */
interface VideoSourceLedgerBase {
  schemaVersion: 1;
  sourceFingerprint: string;
  producerVersion: 1;
  attempt: VideoSourceLedgerAttempt;
  presentation: OwnedVideoPresentation;
}
/** Complete companion JSON; only the original selected track is retained. */
export type VideoSourceLedgerCompanion = VideoSourceLedgerBase & ({
  strategy: 'iso_explicit_rate_one' | 'iso_unedited_rate_one';
  physical: PhysicalVideoProbe;
  container: { kind: 'iso_bmff'; movieTimescale: string; movieDurationTicks: string; track: IsoBmffTrackMetadata };
} | {
  strategy: 'matroska_rate_one';
  physical: MatroskaPhysicalVideoProbe;
  container: { kind: 'matroska'; timestampScaleNs: string; track: MatroskaTrackMetadata; blocks: MatroskaBlockMetadata[] };
});
/** Independent capability state; ready means a stored receipt exists. */
export type VideoSourceLedgerState = null | {
  state: 'pending'; schemaVersion: 1; sourceFingerprint: string; producerVersion: 1; attempt: VideoSourceLedgerAttempt;
} | { state: 'ready'; receipt: VideoSourceLedgerReceipt } | {
  state: 'failed'; schemaVersion: 1; sourceFingerprint: string; producerVersion: 1; attempt: VideoSourceLedgerAttempt; errorCode: string;
};
/** Mandatory caller ceilings without operational defaults in the parser. */
export interface VideoSourceLedgerParseLimits { maxPhysicalFrames: number; maxOccurrences: number }
