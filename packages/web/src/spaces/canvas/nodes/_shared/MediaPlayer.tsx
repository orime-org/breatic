// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize } from 'lucide-react';

import { Slider } from '@web/components/ui/slider';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import type { NodeResolution } from '@web/spaces/canvas/nodes/_shared/NodeResolutionBadge';
import { useMediaPlayer } from '@web/spaces/canvas/nodes/_shared/useMediaPlayer';
import { Waveform } from '@web/spaces/canvas/nodes/_shared/Waveform';

interface MediaPlayerProps {
  /** Which media kind to render. */
  modality: 'audio' | 'video';
  /** Media source URL (the permanent public `adapter.publicUrl` value). */
  src: string;
  /** Poster image (video only). */
  poster?: string;
  /**
   * `'full'` (default) — the node player with volume + fullscreen.
   * `'preview'` (#1622) — the hover-preview player: play + seek only, NO
   * volume popover and NO fullscreen. Both are dropped because a hover
   * preview is a quick "sense what it is" surface, and both would fight a
   * HoverCard: the volume is a portaled Popover (a DOM sibling of the
   * card, so moving to it leaves the card) and fullscreen takes over the
   * screen (exiting it leaves the card). See the hover-preview spec.
   */
  variant?: 'full' | 'preview';
  /**
   * Reports the video's intrinsic pixel size once metadata loads (video only —
   * audio has no pixel dimensions and never fires this). Lets the node render a
   * resolution badge without a data-model field.
   */
  onDimensions?: (resolution: NodeResolution) => void;
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
 * {@link useMediaPlayer}. Sliders are div-based {@link Slider} (Radix) so they
 * render identically across browsers; volume lives in a click-popover vertical
 * slider so it never eats the control-bar width. Video controls overlay the
 * picture bottom (the video fills the node); audio controls sit below the
 * decorative {@link Waveform}, which doubles as the seek surface. Every
 * interactive control carries `nodrag` so ReactFlow does not hijack drags.
 * Zero third-party player dependency.
 * @param root0 - Component props.
 * @param root0.modality - `'audio'` or `'video'`.
 * @param root0.src - Media source URL.
 * @param root0.poster - Poster image (video only).
 * @param root0.onDimensions - Reports the video's intrinsic pixel size on metadata load (video only).
 * @returns The media player element.
 */
export function MediaPlayer({
  modality,
  src,
  poster,
  onDimensions,
  variant = 'full',
}: MediaPlayerProps): React.JSX.Element {
  const ref = React.useRef<HTMLMediaElement>(null);
  const p = useMediaPlayer(ref);
  const isVideo = modality === 'video';
  // #1622: the hover-preview variant drops volume (a portaled Popover) and
  // fullscreen so it can live inside an auto-close HoverCard.
  const showVolume = variant !== 'preview';
  const showFullscreen = variant !== 'preview';

  // Video controls sit on a dark scrim (light-on-video); audio controls sit on
  // the themed node surface.
  const btnCls = `inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-chrome ${
    isVideo ? 'hover:bg-white/20' : 'hover:bg-accent hover:text-accent-foreground'
  }`;
  const volumePct = Math.round((p.muted ? 0 : p.volume) * 100);

  const playButton = (
    <button
      type='button'
      onClick={p.togglePlay}
      aria-label={p.playing ? 'Pause' : 'Play'}
      data-testid='play-toggle'
      className={btnCls}
    >
      {p.playing ? <Pause className='h-4 w-4' /> : <Play className='h-4 w-4' />}
    </button>
  );

  const volumeControl = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={p.muted ? 'Unmute' : 'Mute'}
          data-testid='volume-button'
          className={btnCls}
        >
          {p.muted ? (
            <VolumeX className='h-4 w-4' />
          ) : (
            <Volume2 className='h-4 w-4' />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        className='nodrag flex w-auto min-w-0 flex-col items-center gap-2 p-2'
      >
        <span
          data-testid='volume-pct'
          className='w-6 text-center text-2xs tabular-nums text-muted-foreground'
        >
          {volumePct}
        </span>
        <Slider
          orientation='vertical'
          data-testid='volume'
          aria-label='Volume'
          min={0}
          max={100}
          step={1}
          value={[volumePct]}
          onValueChange={([v]) => p.setVolumeLevel(v / 100)}
          className='h-24 text-foreground'
        />
      </PopoverContent>
    </Popover>
  );

  if (isVideo) {
    return (
      <div className='relative' data-testid='media-player'>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded asset; no caption track until caption authoring lands. */}
        <video
          ref={ref as React.RefObject<HTMLVideoElement>}
          src={src}
          poster={poster}
          playsInline
          // Explicit contract — the spec leaves the missing-value default to
          // the UA. Metadata covers the duration display + dimension badge
          // without downloading the full file per node (#1772).
          preload='metadata'
          data-testid='media-element'
          className='block w-full'
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth > 0 && v.videoHeight > 0) {
              onDimensions?.({ width: v.videoWidth, height: v.videoHeight });
            }
          }}
        />
        <div
          data-testid='controls'
          className='nodrag absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-white'
        >
          {playButton}
          <span
            data-testid='time-current'
            className='shrink-0 text-2xs tabular-nums'
          >
            {formatTime(p.currentTime)}
          </span>
          <Slider
            data-testid='seek'
            aria-label='Seek'
            min={0}
            max={100}
            step={0.1}
            value={[p.progress * 100]}
            onValueChange={([v]) => p.seekFraction(v / 100)}
            className='min-w-0 flex-1'
          />
          <span
            data-testid='time-total'
            className='shrink-0 text-2xs tabular-nums'
          >
            {formatTime(p.duration)}
          </span>
          {showVolume ? volumeControl : null}
          {showFullscreen ? (
            <button
              type='button'
              onClick={p.requestFullscreen}
              aria-label='Fullscreen'
              data-testid='fullscreen'
              className={btnCls}
            >
              <Maximize className='h-4 w-4' />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-2' data-testid='media-player'>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded asset; no caption track until caption authoring lands. */}
      <audio
        ref={ref as React.RefObject<HTMLAudioElement>}
        src={src}
        // Same contract as the video element above (#1772).
        preload='metadata'
        data-testid='media-element'
        className='sr-only'
      />
      <Waveform progress={p.progress} />
      <div
        data-testid='controls'
        className='nodrag flex items-center gap-2 text-popover-foreground'
      >
        {playButton}
        <span
          data-testid='time-current'
          className='shrink-0 text-2xs tabular-nums text-muted-foreground'
        >
          {formatTime(p.currentTime)}
        </span>
        <Slider
          data-testid='seek'
          aria-label='Seek'
          min={0}
          max={100}
          step={0.1}
          value={[p.progress * 100]}
          onValueChange={([v]) => p.seekFraction(v / 100)}
          className='min-w-0 flex-1'
        />
        <span
          data-testid='time-total'
          className='shrink-0 text-2xs tabular-nums text-muted-foreground'
        >
          {formatTime(p.duration)}
        </span>
        {showVolume ? volumeControl : null}
      </div>
    </div>
  );
}
