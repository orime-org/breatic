// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether the cut band draws an audio source's waveform (inner#1305 §4.4).
 * The browser downloads the whole file and decodes it to draw one, so the
 * source's size bounds the download and its length the memory; a source
 * whose size or address is unknown, or ceilings not yet loaded, stays plain.
 */

/** What the band knows about the source. */
export interface WaveformSource {
  url?: string | undefined;
  duration?: number | undefined;
  sizeBytes?: number | undefined;
}

/**
 * Whether to draw the source's waveform.
 * @param source - The source.
 * @param limits - The ceilings the server serves, null before they load.
 * @returns True within both ceilings.
 */
export function waveformDrawable(
  source: WaveformSource,
  limits: { maxSeconds: number; maxBytes: number } | null,
): boolean {
  if (limits === null || source.url === undefined || source.duration === undefined || source.sizeBytes === undefined) {
    return false;
  }
  return source.duration <= limits.maxSeconds && source.sizeBytes <= limits.maxBytes;
}
