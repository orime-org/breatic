// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { getCachedWaveformLimits } from '@web/data/api/canvas';
import { waveformDecodable } from '@web/spaces/canvas/mini-tool/audio-waveform';
import { AudioWaveform } from '@web/spaces/canvas/mini-tool/AudioWaveform';
import { useAudioPeaks, type PeaksRetry } from '@web/spaces/canvas/mini-tool/use-audio-peaks';

interface AudioBandWaveformProps {
  url: string;
  duration: number | undefined;
  sizeBytes: number | undefined;
}

/**
 * What the cut band draws under an audio source (inner#1305 §4.4): the
 * waveform from the peaks file beside it, at any length; while that file is
 * missing, the browser's own decode of a source within the ceilings; anything
 * else leaves the band plain. A band past the ceilings reads the missing file
 * again on the served interval, so audio just made turns into a waveform once
 * its peaks are written.
 * @param root0 - Props.
 * @param root0.url - The audio's address.
 * @param root0.duration - Its length in seconds, when known.
 * @param root0.sizeBytes - Its size, when known.
 * @returns The waveform, or null for a plain band.
 */
export const AudioBandWaveform = React.memo(function AudioBandWaveform({
  url,
  duration,
  sizeBytes,
}: AudioBandWaveformProps): React.JSX.Element | null {
  const limits = getCachedWaveformLimits();
  const decodable = waveformDecodable({ url, duration, sizeBytes }, limits);
  const retryMs = limits?.peaksRetryMs;
  const retryMaxMs = limits?.peaksRetryMaxMs;
  const retry = React.useMemo<PeaksRetry | null>(
    () =>
      decodable || retryMs === undefined || retryMaxMs === undefined ? null : { everyMs: retryMs, forMs: retryMaxMs },
    [decodable, retryMs, retryMaxMs],
  );
  const peaks = useAudioPeaks(url, retry);
  if (peaks.kind === 'ready' && duration !== undefined) {
    return <AudioWaveform src={url} peaks={peaks.peaks} duration={duration} />;
  }
  if (peaks.kind === 'missing' && decodable) return <AudioWaveform src={url} />;
  return null;
});
