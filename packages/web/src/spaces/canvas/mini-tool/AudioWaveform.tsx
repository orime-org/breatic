// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import WaveSurfer from 'wavesurfer.js';

import { AUDIO_PEAK_MAX } from '@breatic/shared';

import { corsUrl } from '@web/lib/cors-url';

/** The rate the waveform is decoded at: enough for a 36px band, a fraction of the memory. */
const DECODE_RATE = 3000;

/**
 * The document's theme, which the bars are coloured by when they are painted:
 * the canvas keeps the colour it was drawn in, so a change draws them again.
 * @returns The `data-theme` on the document, or undefined when none is set.
 */
function useDocumentTheme(): string | undefined {
  const [theme, setTheme] = React.useState(() => document.documentElement.dataset.theme);
  React.useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

interface AudioWaveformProps {
  src: string;
  /** The source's peaks file values; when given, the file is not loaded at all. */
  peaks?: readonly number[] | undefined;
  /** The source's length in seconds, which drawing from peaks needs. */
  duration?: number | undefined;
}

/**
 * An audio source's waveform, filling its box, for the cut band (inner#1305
 * §4.4). Drawn by wavesurfer.js from the peaks file beside the audio when one
 * is given, which loads no audio; otherwise from the file decoded at a low
 * rate. It does not play. Until it has drawn, and if it cannot, the box shows
 * nothing and the band under it stays plain.
 * @param root0 - Props.
 * @param root0.src - The audio URL.
 * @param root0.peaks - The peaks file's values, when there is one.
 * @param root0.duration - The audio's length, which drawing from peaks needs.
 * @returns The waveform's box.
 */
export const AudioWaveform = React.memo(function AudioWaveform({
  src,
  peaks,
  duration,
}: AudioWaveformProps): React.JSX.Element {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [failed, setFailed] = React.useState(false);
  const theme = useDocumentTheme();

  React.useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    setFailed(false);
    const color = getComputedStyle(box).color;
    // Without peaks the file is decoded. The node's own player fetched it
    // without CORS; a fresh CORS fetch keeps that cached response from being
    // handed to this one.
    const source =
      peaks !== undefined && duration !== undefined
        ? { peaks: [Float32Array.from(peaks, (value) => value / AUDIO_PEAK_MAX)], duration }
        : { url: corsUrl(src) };
    const surfer = WaveSurfer.create({
      container: box,
      ...source,
      height: 'auto',
      waveColor: color,
      progressColor: color,
      cursorWidth: 0,
      interact: false,
      normalize: true,
      barWidth: 1,
      barGap: 1,
      sampleRate: DECODE_RATE,
    });
    const offError = surfer.on('error', () => setFailed(true));
    return () => {
      offError();
      surfer.destroy();
    };
  }, [src, peaks, duration, theme]);

  return (
    <div
      ref={boxRef}
      data-testid='mini-tool-waveform'
      data-state={failed ? 'failed' : 'drawn'}
      data-from={peaks !== undefined && duration !== undefined ? 'peaks' : 'decode'}
      // wavesurfer.js lifts its waveform with a z-index inside its shadow root;
      // isolating the box keeps it under the band's dimmed ends and handles.
      // Thin bars that stop short of the band's edges leave the handles on
      // them visible, as the approved demo draws it.
      className={failed ? 'hidden' : 'absolute inset-x-0 inset-y-1 isolate text-foreground'}
    />
  );
});
