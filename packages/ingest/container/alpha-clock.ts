// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Exact measured clocks; integer timestamps are retained without decimal rounding. */
export interface AlphaPresentationClock {
  videoTimeBase: string;
  videoStartPts: string;
  videoDuration: string;
  frames: { pts: string; duration: string }[];
  audio: { timeBase: string; startPts: string; duration: string; sampleRate: number; channels: number }[];
}

/**
 * Parse an exact clock fraction without decimal coercion.
 * @param ticks - Measured integer timestamp.
 * @param timeBase - Measured positive rational source clock.
 * @returns Its exact numerator and denominator, or none for missing facts.
 * @throws {never} Malformed fields are rejected before integer conversion.
 */
function fraction(ticks: string, timeBase: string): readonly [bigint, bigint] | null {
  if (!/^-?\d+$/.test(ticks) || !/^\d+\/\d+$/.test(timeBase)) return null;
  const [numerator, denominator] = timeBase.split('/').map(BigInt);
  if (numerator === undefined || denominator === undefined || numerator <= 0n || denominator <= 0n) return null;
  return [BigInt(ticks) * numerator, denominator];
}

/**
 * Compare exact timestamps on independently encoded rational clocks.
 * @param left - Source ticks.
 * @param leftBase - Source rational clock.
 * @param right - Encoded ticks.
 * @param rightBase - Encoded rational clock.
 * @returns Whether both valid measurements are the same instant or duration.
 * @throws {never} Invalid clocks never compare equal.
 */
function equal(left: string, leftBase: string, right: string, rightBase: string): boolean {
  const a = fraction(left, leftBase);
  const b = fraction(right, rightBase);
  return a !== null && b !== null && a[0] * b[1] === b[0] * a[1];
}

/**
 * Verify complete source coverage on exact source and output rational clocks.
 * @param source - All canonical decoded frames and independent audio streams.
 * @param packed - All actual packed frames and audio streams measured after encoding.
 * @returns Whether no frame, duration, stream offset or audio coverage changed.
 * @throws {never} Unknown or inconsistent clocks fail verification.
 */
export function verifyAlphaPackedClock(source: AlphaPresentationClock, packed: AlphaPresentationClock): boolean {
  if (source.frames.length === 0 || source.frames.length !== packed.frames.length || source.audio.length !== packed.audio.length) return false;
  const declaredDuration = fraction(source.videoDuration, source.videoTimeBase);
  if (declaredDuration === null || declaredDuration[0] <= 0n ||
    !equal(source.videoStartPts, source.videoTimeBase, packed.videoStartPts, packed.videoTimeBase) ||
    !equal(source.videoDuration, source.videoTimeBase, packed.videoDuration, packed.videoTimeBase) ||
    !equal(String(BigInt(source.videoStartPts) + BigInt(source.videoDuration)), source.videoTimeBase,
      String(BigInt(packed.videoStartPts) + BigInt(packed.videoDuration)), packed.videoTimeBase)) return false;
  const videoMatches = source.frames.every((frame, index) => {
    const actual = packed.frames[index]!;
    const duration = fraction(frame.duration, source.videoTimeBase);
    return duration !== null && duration[0] > 0n && equal(frame.pts, source.videoTimeBase, actual.pts, packed.videoTimeBase) &&
      equal(frame.duration, source.videoTimeBase, actual.duration, packed.videoTimeBase);
  });
  if (!videoMatches) return false;
  const last = source.frames[source.frames.length - 1]!;
  const actualLast = packed.frames[packed.frames.length - 1]!;
  if (!equal(String(BigInt(last.pts) + BigInt(last.duration)), source.videoTimeBase,
    String(BigInt(actualLast.pts) + BigInt(actualLast.duration)), packed.videoTimeBase)) return false;
  return source.audio.every((audio, index) => {
    const actual = packed.audio[index]!;
    const duration = fraction(audio.duration, audio.timeBase);
    return duration !== null && duration[0] > 0n && audio.sampleRate === actual.sampleRate && audio.channels === actual.channels &&
      equal(audio.startPts, audio.timeBase, actual.startPts, actual.timeBase) && equal(audio.duration, audio.timeBase, actual.duration, actual.timeBase) &&
      equal(String(BigInt(audio.startPts) + BigInt(audio.duration)), audio.timeBase, String(BigInt(actual.startPts) + BigInt(actual.duration)), actual.timeBase);
  });
}
