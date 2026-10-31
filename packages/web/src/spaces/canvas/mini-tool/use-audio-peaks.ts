// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { fetchAudioPeaks } from '@web/spaces/canvas/mini-tool/audio-peaks';

/** Where an audio source's peaks stand for an open cut band. */
export type AudioPeaksState =
  | { kind: 'loading' }
  | { kind: 'ready'; peaks: number[] }
  | { kind: 'missing' }
  | { kind: 'invalid' };

/** How often, and for how long, to read peaks that are not there yet. */
export interface PeaksRetry {
  everyMs: number;
  forMs: number;
}

/**
 * An audio source's peaks while its cut band is open (inner#1305 §4.4).
 *
 * Peaks are written after the audio registers, so a band opened on audio just
 * made may find none; with `retry`, it reads them again on that interval until
 * they land or `forMs` has passed since it opened.
 * @param audioUrl - The audio's address.
 * @param retry - When to read missing peaks again, or null to read once.
 * @returns Where the peaks stand.
 */
export function useAudioPeaks(audioUrl: string, retry: PeaksRetry | null): AudioPeaksState {
  const [state, setState] = React.useState<AudioPeaksState>({ kind: 'loading' });
  const everyMs = retry?.everyMs;
  const forMs = retry?.forMs;

  React.useEffect(() => {
    const controller = new AbortController();
    const openedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ kind: 'loading' });

    /** Read the peaks, and schedule the next read while they are missing. */
    const read = async (): Promise<void> => {
      const got = await fetchAudioPeaks(audioUrl, controller.signal);
      if (controller.signal.aborted) return;
      if (got === 'missing' || got === 'invalid') {
        setState({ kind: got });
        const due = Date.now() + (everyMs ?? 0) - openedAt;
        if (got === 'missing' && everyMs !== undefined && forMs !== undefined && due <= forMs) {
          timer = setTimeout(() => void read(), everyMs);
        }
        return;
      }
      setState({ kind: 'ready', peaks: got });
    };
    void read();

    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [audioUrl, everyMs, forMs]);

  return state;
}
