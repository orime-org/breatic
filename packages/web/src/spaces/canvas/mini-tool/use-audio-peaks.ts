// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
 * Peaks are written after the audio registers, so a band opened on audio just made may find none; it reads them once
 * more when the server announces them for this audio (`announceAudioPeaksReady`).
 * @param audioUrl - The audio's address.
 * @returns Where the peaks stand.
 */
export function useAudioPeaks(audioUrl: string): AudioPeaksState {
  const [state, setState] = React.useState<AudioPeaksState>({ kind: 'loading' });

  React.useEffect(() => {
    const controller = new AbortController();
    let missing = false;
    setState({ kind: 'loading' });

    /** Read the peaks once. */
    const read = async (): Promise<void> => {
      const got = await fetchAudioPeaks(audioUrl, controller.signal);
      if (controller.signal.aborted) return;
      missing = got === 'missing';
      setState(got === 'missing' || got === 'invalid' ? { kind: got } : { kind: 'ready', peaks: got });
    };
    void read();
    const stop = onAudioPeaksReady((ready) => {
      if (ready === audioUrl && missing && !controller.signal.aborted) {
        missing = false;
        void read();
      }
    });

    return () => {
      controller.abort();
      stop();
    };
  }, [audioUrl]);

  return state;
}
