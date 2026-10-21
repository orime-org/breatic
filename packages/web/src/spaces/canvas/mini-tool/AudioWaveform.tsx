// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import WaveSurfer from 'wavesurfer.js';

import { corsUrl } from '@web/lib/cors-url';

/** The rate the waveform is decoded at: enough for a 36px band, a fraction of the memory. */
const DECODE_RATE = 3000;

interface AudioWaveformProps {
  src: string;
}

/**
 * An audio source's waveform, filling its box, for the cut band (inner#1305
 * §4.4). Drawn by wavesurfer.js from the file decoded at a low rate; it does
 * not play. Until the file has decoded, and if it cannot be, the box shows
 * nothing and the band under it stays plain.
 * @param root0 - Props.
 * @param root0.src - The audio URL.
 * @returns The waveform's box.
 */
export const AudioWaveform = React.memo(function AudioWaveform({ src }: AudioWaveformProps): React.JSX.Element {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    setFailed(false);
    const color = getComputedStyle(box).color;
    const surfer = WaveSurfer.create({
      container: box,
      // The node's own player fetched this file without CORS; a fresh CORS fetch
      // keeps that cached response from being handed to this one.
      url: corsUrl(src),
      height: 'auto',
      waveColor: color,
      progressColor: color,
      cursorWidth: 0,
      interact: false,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      sampleRate: DECODE_RATE,
    });
    const offError = surfer.on('error', () => setFailed(true));
    return () => {
      offError();
      surfer.destroy();
    };
  }, [src]);

  return (
    <div
      ref={boxRef}
      data-testid='mini-tool-waveform'
      data-state={failed ? 'failed' : 'drawn'}
      className={failed ? 'hidden' : 'absolute inset-0 text-muted-foreground'}
    />
  );
});
