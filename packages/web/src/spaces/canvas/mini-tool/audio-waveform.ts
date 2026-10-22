// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether the cut band may decode an audio source in the browser to draw its
 * waveform while the source has no peaks file (inner#1305 §4.4). The browser
 * downloads the whole file and decodes it, so the source's size bounds the
 * download and its length the memory; a source whose length, size or address
 * is unknown, or ceilings not yet loaded, is not decoded.
 */

/** What the band knows about the source. */
export interface WaveformSource {
  url?: string | undefined;
  duration?: number | undefined;
  sizeBytes?: number | undefined;
}

/**
 * Whether the browser may decode the source to draw its waveform.
 * @param source - The source.
 * @param limits - The ceilings the server serves, null before they load.
 * @returns True within both ceilings.
 */
export function waveformDecodable(
  source: WaveformSource,
  limits: { maxSeconds: number; maxBytes: number } | null,
): boolean {
  if (limits === null || source.url === undefined || source.duration === undefined || source.sizeBytes === undefined) {
    return false;
  }
  return source.duration <= limits.maxSeconds && source.sizeBytes <= limits.maxBytes;
}
