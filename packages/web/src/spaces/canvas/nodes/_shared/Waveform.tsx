// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

const BAR_COUNT = 48;
const SEEK_STEP = 0.05;

// A fixed decorative bar shape (0..1 heights), identical for every audio node —
// NOT derived from the actual audio. Deterministic so the canvas stays stable.
const BARS: readonly number[] = Array.from({ length: BAR_COUNT }, (_, i) =>
  Math.max(
    0.25,
    Math.abs(Math.sin(i * 1.7) * 0.6 + Math.sin(i * 0.5) * 0.4),
  ),
);

interface WaveformProps {
  /** Played fraction, 0..1 — fills the bars left-to-right. */
  progress: number;
  /** Seek to a fraction of the duration (click position or keyboard step). */
  onSeek: (fraction: number) => void;
  /** Accessible label for the slider. */
  ariaLabel: string;
}

/**
 * Decorative audio waveform: a fixed static bar shape whose bars fill with the
 * `foreground` colour left-to-right as `progress` grows (the playback
 * indicator). Doubles as the seek surface — click or arrow-key to seek. It does
 * NOT decode audio; the shape is purely visual (per the media-player spec).
 * @param root0 - Component props.
 * @param root0.progress - Played fraction 0..1.
 * @param root0.onSeek - Seek callback, receives a 0..1 fraction.
 * @param root0.ariaLabel - Accessible slider label.
 * @returns The waveform slider element.
 */
export function Waveform({
  progress,
  onSeek,
  ariaLabel,
}: WaveformProps): React.JSX.Element {
  return (
    <div
      role='slider'
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      data-testid='waveform'
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const f = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
        onSeek(Math.min(1, Math.max(0, f)));
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onSeek(Math.min(1, progress + SEEK_STEP));
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onSeek(Math.max(0, progress - SEEK_STEP));
        }
      }}
      className='flex h-12 cursor-pointer items-center gap-px outline-none focus-visible:ring-1 focus-visible:ring-ring'
    >
      {BARS.map((h, i) => (
        <span
          key={i}
          data-testid='waveform-bar'
          className={`min-h-[2px] flex-1 rounded-full ${
            i / BAR_COUNT < progress
              ? 'bg-foreground'
              : 'bg-muted-foreground/40'
          }`}
          style={{ height: `${Math.round(h * 100)}%` }}
        />
      ))}
    </div>
  );
}
