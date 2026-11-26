// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';

import { fetchAudioPeaks } from '@web/spaces/canvas/mini-tool/audio-peaks';
import { onAudioPeaksReady } from '@web/spaces/canvas/mini-tool/audio-peaks-ready';

/** Where an audio source's peaks stand for an open cut band. */
export type AudioPeaksState =
  | { kind: 'loading' }
  | { kind: 'ready'; peaks: number[] }
  | { kind: 'missing' }
  | { kind: 'invalid' };

/**
 * An audio source's peaks while its cut band is open (inner#1305 §4.4, #1580).
 *
 * Peaks are written after the audio registers, so a band opened on audio just made may find none; until it has them it
 * reads them again whenever the server announces them for this audio (`announceAudioPeaksReady`).
 * @param audioUrl - The audio's address.
 * @returns Where the peaks stand.
 */
export function useAudioPeaks(audioUrl: string): AudioPeaksState {
  const [state, setState] = React.useState<AudioPeaksState>({ kind: 'loading' });

  React.useEffect(() => {
    const controller = new AbortController();
    let have = false;
    let latest = 0;
    setState({ kind: 'loading' });

    /** Read the peaks; only the answer to the latest read counts, so an earlier "not there" never covers them. */
    const read = async (): Promise<void> => {
      latest += 1;
      const mine = latest;
      const got = await fetchAudioPeaks(audioUrl, controller.signal);
      if (controller.signal.aborted || mine !== latest) return;
      have = got !== 'missing' && got !== 'invalid';
      setState(got === 'missing' || got === 'invalid' ? { kind: got } : { kind: 'ready', peaks: got });
    };
    void read();
    // A read still on the way may have been answered before storage held the file, so every announcement reads
    // again until the peaks are in.
    const stop = onAudioPeaksReady((ready) => {
      if (ready === audioUrl && !have && !controller.signal.aborted) void read();
    });

    return () => {
      controller.abort();
      stop();
    };
  }, [audioUrl]);

  return state;
}
