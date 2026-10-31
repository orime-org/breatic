// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a stored audio object's peaks live, and what they hold (inner#1305).
 *
 * The cut band draws an audio source's waveform from a small file the media
 * container writes beside it, so the page never decodes the audio. Like an
 * image's preview, the key is derived from the audio's own and nothing in the
 * ledger names it: the Worker that writes it, the backfill that fills it in
 * and every page that reads it apply the same rule here.
 */

import { z } from "zod";

import { AUDIO_PEAK_COUNT, AUDIO_PEAK_MAX } from "@shared/audio-peaks.js";
import { isStoredObjectUrl } from "@shared/upload/preview.js";

/** What a peaks file's key adds to the key of the audio it was read from. */
export const PEAKS_SUFFIX = ".peaks.json";

/**
 * A peaks file: the loudest sample of each of up to {@link AUDIO_PEAK_COUNT}
 * equal stretches of the audio mixed to mono, from 0 (silence) to
 * {@link AUDIO_PEAK_MAX} (full scale).
 */
export const audioPeaksSchema = z.object({
  version: z.literal(1),
  peaks: z.array(z.number().int().min(0).max(AUDIO_PEAK_MAX)).min(1).max(AUDIO_PEAK_COUNT),
});

/** One peaks file. */
export type AudioPeaks = z.infer<typeof audioPeaksSchema>;

/**
 * The key a stored audio object's peaks are written to.
 * @param key - The audio's key.
 * @returns The peaks' key.
 */
export function peaksKeyFor(key: string): string {
  return `${key}${PEAKS_SUFFIX}`;
}

/**
 * The peaks address for an audio address, when it names a stored object.
 * @param url - An audio address as a node holds it.
 * @returns The peaks' address, or null for anything that is not a stored
 *   object's address.
 */
export function peaksUrlFor(url: string): string | null {
  return isStoredObjectUrl(url) ? `${url}${PEAKS_SUFFIX}` : null;
}
