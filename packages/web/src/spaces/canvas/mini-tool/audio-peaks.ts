// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Read an audio source's peaks file for the cut band (inner#1305 §4.4).
 *
 * The file sits beside the audio in storage, written by the media container
 * after the audio registered, so it may not be there yet.
 */

import { audioPeaksSchema, httpRequest, peaksUrlFor } from '@breatic/shared';

/**
 * The peaks beside an audio object.
 * @param audioUrl - The audio's address, as the node holds it.
 * @param signal - Aborts the read.
 * @returns The peaks; `missing` when the file is not there yet or the read
 *   did not get through; `invalid` for a file that is not a peaks file or an
 *   address that names no stored object.
 */
export async function fetchAudioPeaks(audioUrl: string, signal: AbortSignal): Promise<number[] | 'missing' | 'invalid'> {
  const peaksUrl = peaksUrlFor(audioUrl);
  if (peaksUrl === null) return 'invalid';
  let response: Response;
  try {
    response = await httpRequest(peaksUrl, { credentials: 'omit' }, { replaySafe: true, signal });
  } catch {
    return 'missing';
  }
  if (!response.ok) return 'missing';
  const parsed = audioPeaksSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.peaks : 'invalid';
}
