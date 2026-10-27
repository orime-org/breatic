// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Exact owned seconds, reduced with a positive denominator. */
export interface ExactPresentationTime { numerator: string; denominator: string }
/** One actual physical frame in an explicitly unedited decoder clock. */
export interface PhysicalVideoFrame { rawDecodeOrdinal: number; ptsTicks: string }
/** A movie-time interval declared by an edit, including empty intervals with no fabricated frame. */
export interface OwnedEditInterval { editOccurrence: number; empty: boolean; start: ExactPresentationTime; end: ExactPresentationTime }
/** A physical frame may occupy multiple distinct presentation occurrences. */
export interface OwnedPresentationOccurrence {
  presentationOrdinal: number;
  editOccurrence: number;
  rawDecodeOrdinal: number;
  sourcePtsTicks: string;
  mappedPts: ExactPresentationTime;
  displayStart: ExactPresentationTime;
  displayEnd: ExactPresentationTime;
}
/** A pure frozen schedule, distinct from native callbacks and media-clock transport schemas. */
export interface OwnedVideoPresentation { edits: OwnedEditInterval[]; frames: OwnedPresentationOccurrence[] }

/** Complete source edit facts; fixed rate is the original signed 32-bit 16.16 integer. */
export interface IsoBmffEdit {
  segmentDurationMovieTicks: string;
  mediaTimeTrackTicks: string;
  mediaRateFixed16_16: string;
}
/** Compressed decode timing preserves its actual unsigned sample count and delta. */
export interface IsoBmffDecodeRun { sampleCount: number; deltaTicks: string }
/** Composition offsets preserve their versioned integer signedness. */
export interface IsoBmffCompositionRun { sampleCount: number; offsetTicks: string }
/** Original signed cslg fields, without applying a display-window policy. */
export interface IsoBmffCompositionShift {
  version: 0 | 1;
  compositionToDtsShift: string;
  leastDecodeToDisplayDelta: string;
  greatestDecodeToDisplayDelta: string;
  compositionStartTime: string;
  compositionEndTime: string;
}
/** Selected-track sample facts, present only when an actual stts table was read. */
export interface IsoBmffSampleTiming {
  decodeRuns: IsoBmffDecodeRun[];
  cttsVersion: 0 | 1 | null;
  compositionRuns: IsoBmffCompositionRun[] | null;
  compositionShift: IsoBmffCompositionShift | null;
}
/** One explicitly identified track, without inferring its codec or legal display extent. */
export interface IsoBmffTrackMetadata {
  trackId: number;
  trackFlags: number;
  durationMovieTicks: string;
  mediaTimescale: string;
  mediaDurationTicks: string;
  edits: IsoBmffEdit[] | null;
  sampleTiming?: IsoBmffSampleTiming;
}
/** Exact physical video facts retain their original selected stream and integer clock. */
export interface PhysicalVideoProbe {
  streamIndex: number;
  trackId: number;
  sourceTimeBase: { numerator: string; denominator: string };
  frames: { rawDecodeOrdinal: number; ptsTicks: string }[];
}

/** Exact rational value of the original IEEE-754 track-scale representation. */
export interface MatroskaTrackScale { numerator: string; denominator: string }
/** Track identity and effective format defaults, without choosing a video stream. */
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
/** Physical block facts in file order; offsets never identify a BlockGroup wrapper. */
export interface MatroskaBlockMetadata {
  blockOrdinal: number;
  kind: "simple" | "group";
  /** Absolute byte offset of the SimpleBlock or internal Block element ID. */
  elementOffset: string;
  /** First codec frame byte, after the complete block and lace headers. */
  dataOffset: string;
  /** Total codec frame payload bytes, excluding every metadata header. */
  dataBytes: string;
  trackNumber: string;
  clusterTimestampTicks: string;
  relativeTimestampTicks: string;
  invisible: boolean;
  lacing: "none" | "xiph" | "fixed" | "ebml";
  frameCount: number;
  blockDurationTicks: string | null;
  discardPaddingNs: string | null;
}
/** Exact physical Matroska frames bound to original packet/block provenance. */
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
