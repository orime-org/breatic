// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { AUDIO_PEAK_RATE } from "@shared/audio-peaks.js";

import { pickMediaMetadata, realVideoStream } from "@ingest/media-metadata.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

/**
 * How many samples to read an object's peaks from, when it gets peaks at all
 * (inner#1305 §4.4).
 *
 * Only audio does: an object with sound, no picture of its own (album art is
 * not one) and a length to divide into stretches. Decided here rather than in
 * the container's handler so it runs without Docker.
 * @param run - What this run was asked and found.
 * @param run.wantPeaks - Whether the caller asked for peaks.
 * @param run.report - What ffprobe found.
 * @returns The sample count at {@link AUDIO_PEAK_RATE}, or null for no peaks.
 */
export function peaksSampleCount(run: { wantPeaks: boolean; report: ProbeReport }): number | null {
  if (!run.wantPeaks) return null;
  if (!run.report.streams.some((stream) => stream.codecType === "audio")) return null;
  if (realVideoStream(run.report) !== undefined) return null;
  const seconds = pickMediaMetadata(run.report).durationSeconds;
  return seconds === null ? null : Math.ceil(seconds * AUDIO_PEAK_RATE);
}
