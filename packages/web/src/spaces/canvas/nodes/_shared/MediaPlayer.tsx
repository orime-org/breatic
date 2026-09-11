// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Slider } from '@web/components/ui/slider';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { formatSeconds } from '@web/spaces/canvas/lib/duration';
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
   * The running time the ledger measured when this file was stored, if any.
   * It is on the node before the media is fetched, so the scrubber reads the
   * real time straight away instead of "0:00" until enough has decoded.
   */
  duration?: number;
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
  /**
   * Slide the control bar away and take it out of reach (video only —
   * #1987 A5). Set for
   * the whole of a focus pick session: while the user is picking a video to
   * crop, a click on the play button would both toggle playback and count as
   * picking that node, and the frame to crop is chosen on the crop overlay's
   * own timeline instead.
   *
   * The bar stays mounted — `inert` rather than unmounting, so the slide-out
   * has an element to animate while keyboard, screen readers and the pointer
   * all lose it.
   */
  controlsHidden?: boolean;
}

/**
 * The control bar's buttons, at the shared inline-button size.
 *
 * Written as the token rather than the 28px it currently resolves to: these
 * are the same kind of button as the ones in the chrome, and a size stated as
 * a number is one the next change to that scale leaves behind.
 */
const BUTTON_SIZE = 'h-[var(--btn-inline)] w-[var(--btn-inline)]';

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
 * @param root0.duration - The running time the ledger measured, if any.
 * @param root0.variant - `'full'` (node player, default) or `'preview'` (hover preview: no volume / fullscreen).
 * @param root0.onDimensions - Reports the video's intrinsic pixel size on metadata load (video only).
 * @param root0.controlsHidden - Slide the control bar out and make it unreachable (video only, #1987).
 * @returns The media player element.
 */
export function MediaPlayer({
  modality,
  src,
  poster,
  duration,
  onDimensions,
  variant = 'full',
  controlsHidden = false,
}: MediaPlayerProps): React.JSX.Element {
  const ref = React.useRef<HTMLMediaElement>(null);
  const p = useMediaPlayer(ref, duration);
  const isVideo = modality === 'video';
  // #1622: the hover-preview variant drops volume (a portaled Popover) and
  // fullscreen so it can live inside an auto-close HoverCard.
  const showVolume = variant !== 'preview';
  const showFullscreen = variant !== 'preview';

  // Video controls sit on a dark scrim (light-on-video); audio controls sit on
  // the themed node surface.
  // `hover:text-white` on the video branch is not decoration: the `ghost`
  // variant ships `hover:text-accent-foreground`, which would pull the glyph
  // off white on the dark scrim. Restating white keeps the control bar as it
  // renders today.
  // The focus ring is restated for the same reason. `Button` rings in `--ring`,
  // a themed colour read against a themed surface — and this bar's surface is
  // the video's own dark scrim in either theme, so in light theme the ring is
  // dark on dark and a keyboard reader cannot see where they are.
  const btnCls = `inline-flex ${BUTTON_SIZE} shrink-0 items-center justify-center rounded-chrome ${
    isVideo
      ? 'hover:bg-white/20 focus-visible:ring-white'
      : 'hover:bg-accent hover:text-accent-foreground'
  }`;
  const volumePct = Math.round((p.muted ? 0 : p.volume) * 100);

  const playButton = (
    <Button
      type='button'
      variant={null}
      size={null}
      onClick={p.togglePlay}
      aria-label={p.playing ? 'Pause' : 'Play'}
      data-testid='play-toggle'
      className={btnCls}
    >
      {p.playing ? <Pause className='h-4 w-4' /> : <Play className='h-4 w-4' />}
    </Button>
  );

  const volumeControl = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          aria-label={p.muted ? 'Unmute' : 'Mute'}
          data-testid='volume-button'
          className={btnCls}
        >
          {p.muted ? (
            <VolumeX className='h-4 w-4' />
          ) : (
            <Volume2 className='h-4 w-4' />
          )}
        </Button>
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
          inert={controlsHidden}
          className={`nodrag absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-white transition-transform ${
            controlsHidden ? 'translate-y-full' : ''
          }`}
        >
          {playButton}
          <span
            data-testid='time-current'
            className='shrink-0 text-2xs tabular-nums'
          >
            {formatSeconds(p.currentTime)}
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
            {formatSeconds(p.duration)}
          </span>
          {showVolume ? volumeControl : null}
          {showFullscreen ? (
            <Button
              type='button'
              variant={null}
              size={null}
              onClick={p.requestFullscreen}
              aria-label='Fullscreen'
              data-testid='fullscreen'
              className={btnCls}
            >
              <Maximize className='h-4 w-4' />
            </Button>
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
          {formatSeconds(p.currentTime)}
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
          {formatSeconds(p.duration)}
        </span>
        {showVolume ? volumeControl : null}
      </div>
    </div>
  );
}
