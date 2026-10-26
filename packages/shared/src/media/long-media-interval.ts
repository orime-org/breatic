// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { MediaInputDescriptorSchema, type MediaInputDescriptor } from "@shared/media/long-media-schema.js";

/** A half-open interval on the source media timeline, in integer microseconds. */
export interface MediaCoreInterval {
  /** Inclusive source-time start, encoded as an integer string for JSON safety. */
  startUs: string;
  /** Exclusive source-time end, encoded as an integer string for JSON safety. */
  endUs: string;
}

/** A core range and its exact source range for decoding. */
export interface MediaDecodeWindow {
  /** The interval whose result contributes coverage. */
  core: MediaCoreInterval;
  /** The interval read by the decoder. */
  decode: MediaCoreInterval;
}

/** One trusted source file and its measured timeline. */
export interface LongMediaInputRange {
  /** Stable identity of this complete media file. */
  mediaInputId: string;
  /** Probe-derived audio or video file kind. */
  descriptor: MediaInputDescriptor;
  /** The exact source-time range that this input must cover. */
  sourceRange: MediaCoreInterval;
}

/** Frozen limits for creating a complete media segment plan. */
export interface LongMediaPlanLimits {
  /** Maximum source-time core width for an audio file. */
  audioCoreSeconds: number;
  /** Maximum source-time core width for a video file. */
  videoCoreSeconds: number;
  /** Maximum segment count for the source file. */
  maxActiveLeaves: number;
}

/** One ordered source-file segment with the interval sent to the decoder. */
export interface LongMediaPlannedSegment {
  /** Stable identity derived from media input and source-time core. */
  id: string;
  /** Required media input this leaf covers. */
  mediaInputId: string;
  /** Probe-derived source streams and channel for this leaf. */
  descriptor: MediaInputDescriptor;
  /** Source interval covered by this segment. */
  core: MediaCoreInterval;
  /** Source interval decoded for this segment. */
  decode: MediaCoreInterval;
}

/**
 * Plan contiguous source-time cores for one complete media file.
 *
 * Audio files use the audio core limit and video files use the video core limit.
 * Decoded ranges equal their covered ranges, so adjacent segments have no overlap.
 * @param inputs - The single probe-derived source file.
 * @param limits - The immutable operation processing limits.
 * @returns Ordered leaves whose cores exactly cover each input range.
 * @throws {RangeError} when the source, limit, range, or segment budget is invalid.
 */
export function planLongMediaSegments(
  inputs: readonly LongMediaInputRange[],
  limits: LongMediaPlanLimits,
): LongMediaPlannedSegment[] {
  if (
    inputs.length !== 1 ||
    !Number.isSafeInteger(limits.audioCoreSeconds) || limits.audioCoreSeconds <= 0 ||
    !Number.isSafeInteger(limits.videoCoreSeconds) || limits.videoCoreSeconds <= 0 ||
    !Number.isSafeInteger(limits.maxActiveLeaves) || limits.maxActiveLeaves <= 0
  ) {
    throw new RangeError("Long media planning requires one source file and valid limits.");
  }

  const segments: LongMediaPlannedSegment[] = [];
  const input = inputs[0]!;
  if (input.mediaInputId.length === 0) throw new RangeError("A long media source identity must be non-empty.");
  const parsedDescriptor = MediaInputDescriptorSchema.safeParse(input.descriptor);
  if (!parsedDescriptor.success) throw new RangeError("The long media source descriptor is invalid.");
  const sourceStartUs = integerUs(input.sourceRange.startUs);
  const sourceEndUs = integerUs(input.sourceRange.endUs);
  if (sourceEndUs <= sourceStartUs) throw new RangeError("A long media source range must have positive duration.");

  const coreSeconds = parsedDescriptor.data.mediaKind === "audio"
    ? limits.audioCoreSeconds
    : limits.videoCoreSeconds;
  const coreWidthUs = BigInt(coreSeconds) * 1_000_000n;
  let coreStartUs = sourceStartUs;

  while (coreStartUs < sourceEndUs) {
    if (segments.length >= limits.maxActiveLeaves) {
      throw new RangeError("The long media plan exceeds the source segment limit.");
    }
    const coreEndUs = coreStartUs + coreWidthUs < sourceEndUs ? coreStartUs + coreWidthUs : sourceEndUs;
    const core = { startUs: String(coreStartUs), endUs: String(coreEndUs) };
    const window = expandMediaDecodeWindow(core, input.sourceRange, "0");
    segments.push({
      id: `${input.mediaInputId}:${core.startUs}:${core.endUs}`,
      mediaInputId: input.mediaInputId,
      descriptor: parsedDescriptor.data,
      core: window.core,
      decode: window.decode,
    });
    coreStartUs = coreEndUs;
  }

  return segments;
}

/**
 * Bisect one source-time core without changing its covered time range.
 * @param core - The half-open source-time interval to split.
 * @returns The adjacent left and right child cores.
 * @throws {RangeError} when the interval is malformed or narrower than two microseconds.
 */
export function bisectMediaCore(core: MediaCoreInterval): [MediaCoreInterval, MediaCoreInterval] {
  const startUs = integerUs(core.startUs);
  const endUs = integerUs(core.endUs);
  const widthUs = endUs - startUs;
  if (widthUs < 2n) throw new RangeError("A media core needs at least two microseconds to bisect.");

  const middleUs = startUs + widthUs / 2n;
  return [
    { startUs: String(startUs), endUs: String(middleUs) },
    { startUs: String(middleUs), endUs: String(endUs) },
  ];
}

/**
 * Expand a core by decode overlap while keeping it inside the source range.
 * @param core - The half-open interval whose result counts toward coverage.
 * @param source - The available half-open source interval.
 * @param overlapUs - The non-negative overlap on each side, as decimal microseconds.
 * @returns The unchanged core and its clamped decode interval.
 * @throws {RangeError} when an interval is invalid, outside the source, or overlap is negative.
 */
export function expandMediaDecodeWindow(
  core: MediaCoreInterval,
  source: MediaCoreInterval,
  overlapUs: string,
): MediaDecodeWindow {
  const coreStartUs = integerUs(core.startUs);
  const coreEndUs = integerUs(core.endUs);
  const sourceStartUs = integerUs(source.startUs);
  const sourceEndUs = integerUs(source.endUs);
  const overlap = integerUs(overlapUs);
  if (sourceEndUs <= sourceStartUs || coreEndUs <= coreStartUs || overlap < 0n) {
    throw new RangeError("Media source, core, and overlap ranges must be valid.");
  }
  if (coreStartUs < sourceStartUs || coreEndUs > sourceEndUs) {
    throw new RangeError("A media core must be inside its source range.");
  }

  return {
    core: { startUs: String(coreStartUs), endUs: String(coreEndUs) },
    decode: {
      startUs: String(coreStartUs - overlap > sourceStartUs ? coreStartUs - overlap : sourceStartUs),
      endUs: String(coreEndUs + overlap < sourceEndUs ? coreEndUs + overlap : sourceEndUs),
    },
  };
}

/**
 * Parse a decimal integer timestamp without passing through floating point.
 * @param value - The wire representation of integer microseconds.
 * @returns The exact integer value.
 * @throws {RangeError} when the value is not a decimal integer string.
 */
function integerUs(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) throw new RangeError("Media timestamps must be decimal integer strings.");
  return BigInt(value);
}
