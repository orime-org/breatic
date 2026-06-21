// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

const BAR_COUNT = 48;

// A fixed decorative bar shape (0..1 heights), identical for every audio node —
// NOT derived from the actual audio. Deterministic so the canvas stays stable.
const BARS: readonly number[] = Array.from({ length: BAR_COUNT }, (_, i) =>
  Math.max(0.25, Math.abs(Math.sin(i * 1.7) * 0.6 + Math.sin(i * 0.5) * 0.4)),
);

interface WaveformProps {
  /** Played fraction, 0..1 — fills the bars left-to-right. */
  progress: number;
}

/**
 * Decorative audio waveform: a fixed static bar shape whose bars fill with a
 * mid-grey `muted-foreground` left-to-right as `progress` grows (the playback
 * indicator). It is purely a visual progress display — it does NOT seek and
 * carries no `nodrag`, so dragging it moves the node (the seek lives in the
 * control row below). The shape does NOT decode audio (per the media-player
 * spec). Played / unplayed both stay in the neutral `muted-foreground` family
 * so the fill is never the harsh `foreground` extreme in either colour mode.
 * @param root0 - Component props.
 * @param root0.progress - Played fraction 0..1.
 * @returns The decorative waveform element.
 */
export function Waveform({ progress }: WaveformProps): React.JSX.Element {
  return (
    <div data-testid='waveform' className='flex h-12 items-center gap-px'>
      {BARS.map((h, i) => (
        <span
          key={i}
          data-testid='waveform-bar'
          className={`min-h-[2px] flex-1 rounded-full ${
            i / BAR_COUNT < progress
              ? 'bg-muted-foreground'
              : 'bg-muted-foreground/30'
          }`}
          style={{ height: `${Math.round(h * 100)}%` }}
        />
      ))}
    </div>
  );
}
