// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize } from 'lucide-react';

import { useMediaPlayer } from '@web/spaces/canvas/nodes/_shared/useMediaPlayer';
import { Waveform } from '@web/spaces/canvas/nodes/_shared/Waveform';

interface MediaPlayerProps {
  /** Which media kind to render. */
  modality: 'audio' | 'video';
  /** Media source URL (presigned). */
  src: string;
  /** Poster image (video only). */
  poster?: string;
}

/**
 * Formats a seconds count as `m:ss` (e.g. 75 → "1:15").
 * @param seconds - Time in seconds.
 * @returns The `m:ss` string ("0:00" for non-finite / negative input).
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Unified canvas media player built on a native `<audio>`/`<video>` element +
 * {@link useMediaPlayer}, with a Tailwind control bar. Audio nodes show a
 * decorative {@link Waveform} that doubles as the seek surface; video nodes
 * show the element plus a linear scrubber and a fullscreen button. Zero
 * third-party player dependency.
 * @param root0 - Component props.
 * @param root0.modality - `'audio'` or `'video'`.
 * @param root0.src - Media source URL.
 * @param root0.poster - Poster image (video only).
 * @returns The media player element.
 */
export function MediaPlayer({
  modality,
  src,
  poster,
}: MediaPlayerProps): React.JSX.Element {
  const ref = React.useRef<HTMLMediaElement>(null);
  const p = useMediaPlayer(ref);
  const isVideo = modality === 'video';

  return (
    <div className='flex flex-col gap-2' data-testid='media-player'>
      {isVideo ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded asset; no caption track until caption authoring lands.
        <video
          ref={ref as React.RefObject<HTMLVideoElement>}
          src={src}
          poster={poster}
          playsInline
          data-testid='media-element'
          className='block w-full rounded-[var(--radius-content-sm)]'
        />
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded asset; no caption track until caption authoring lands.
        <audio
          ref={ref as React.RefObject<HTMLAudioElement>}
          src={src}
          data-testid='media-element'
          className='sr-only'
        />
      )}

      {!isVideo && (
        <Waveform
          progress={p.progress}
          onSeek={p.seekFraction}
          ariaLabel='Audio progress'
        />
      )}

      <div className='flex items-center gap-2 text-popover-foreground'>
        <button
          type='button'
          onClick={p.togglePlay}
          aria-label={p.playing ? 'Pause' : 'Play'}
          data-testid='play-toggle'
          className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-chrome hover:bg-accent'
        >
          {p.playing ? (
            <Pause className='h-4 w-4' />
          ) : (
            <Play className='h-4 w-4' />
          )}
        </button>

        <span
          data-testid='time'
          className='shrink-0 text-2xs tabular-nums text-muted-foreground'
        >
          {formatTime(p.currentTime)} / {formatTime(p.duration)}
        </span>

        {isVideo && (
          <input
            type='range'
            min={0}
            max={1}
            step={0.001}
            value={p.progress}
            onChange={(e) => p.seekFraction(Number(e.target.value))}
            aria-label='Seek'
            data-testid='seek'
            className='h-1 flex-1 cursor-pointer accent-foreground'
          />
        )}

        <button
          type='button'
          onClick={p.toggleMute}
          aria-label={p.muted ? 'Unmute' : 'Mute'}
          data-testid='mute-toggle'
          className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-chrome hover:bg-accent'
        >
          {p.muted ? (
            <VolumeX className='h-4 w-4' />
          ) : (
            <Volume2 className='h-4 w-4' />
          )}
        </button>

        <input
          type='range'
          min={0}
          max={1}
          step={0.01}
          value={p.muted ? 0 : p.volume}
          onChange={(e) => p.setVolumeLevel(Number(e.target.value))}
          aria-label='Volume'
          data-testid='volume'
          className='h-1 w-16 shrink-0 cursor-pointer accent-foreground'
        />

        {isVideo && (
          <button
            type='button'
            onClick={p.requestFullscreen}
            aria-label='Fullscreen'
            data-testid='fullscreen'
            className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-chrome hover:bg-accent'
          >
            <Maximize className='h-4 w-4' />
          </button>
        )}
      </div>
    </div>
  );
}
