// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audio whose peaks were just written (#1580). The Project page hears the `asset-peaks:ready` message on its meta
 * document and names the audio's address here; a cut band waiting for that audio's waveform reads its peaks again.
 */

type Listener = (audioUrl: string) => void;

const listeners = new Set<Listener>();

/**
 * Say the peaks of the audio at `audioUrl` are there to read.
 * @param audioUrl - The audio's own address.
 */
export function announceAudioPeaksReady(audioUrl: string): void {
  for (const listener of listeners) listener(audioUrl);
}

/**
 * Hear each audio whose peaks became readable.
 * @param listener - Called with the audio's address.
 * @returns A function that stops listening.
 */
export function onAudioPeaksReady(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
