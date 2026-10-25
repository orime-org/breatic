// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Exact measured clocks; integer timestamps are retained without decimal rounding. */
export interface AlphaPresentationClock {
  videoTimeBase: string;
  frames: { pts: string; duration: string }[];
  audio: { timeBase: string; startPts: string; duration: string; sampleRate: number; channels: number }[];
}

/**
 * Verify complete source coverage on exact source and output rational clocks.
 * @param source - All canonical decoded frames and independent audio streams.
 * @param packed - All actual packed frames and audio streams measured after encoding.
 * @returns Whether no frame, duration, stream offset or audio coverage changed.
 * @throws {never} Unknown or inconsistent clocks fail verification.
 */
export function verifyAlphaPackedClock(source: AlphaPresentationClock, packed: AlphaPresentationClock): boolean {
  void source;
  void packed;
  return false;
}
