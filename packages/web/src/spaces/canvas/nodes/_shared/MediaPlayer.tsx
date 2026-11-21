// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { VideoPresentationSourceBinding } from '@breatic/shared';
import { presentedSizeOf, runtimeSourceKeyOf, type VideoPresentationSource, type MediaSurfaceSnapshot, type PresentedMediaFrame, type MediaSurfaceBinding } from '@web/spaces/canvas/video-presentation/types';
import { Camera, Play, Pause, Volume2, VolumeX } from 'lucide-react';

import { VideoPresentationSurface } from '@web/spaces/canvas/video-presentation/VideoPresentationSurface';
import { bindVideoDisplay } from '@web/spaces/canvas/video-presentation/video-display-geometry';
import { VideoPreparationNotice, type VideoPreparationState } from '@web/spaces/canvas/video-presentation/VideoPreparationNotice';
import { useTranslation } from '@web/i18n/use-translation';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { Slider } from '@web/components/ui/slider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { usePreviewSrc, usePreviewWidth } from '@web/lib/preview-src';
import { cn } from '@web/lib/utils';
import { formatSeconds } from '@web/spaces/canvas/lib/duration';
import type { NodeResolution } from '@web/spaces/canvas/nodes/_shared/NodeResolutionBadge';
import { useMediaPlayer, writePlayerState, type MediaPlayerState } from '@web/spaces/canvas/nodes/_shared/use-media-player';
import { Waveform } from '@web/spaces/canvas/nodes/_shared/Waveform';
import { MediaControlsPortal, useSeekPointer, type VideoControlsTarget } from '@web/spaces/canvas/nodes/_shared/media-video-controls';

/** What a player lets its owner do from outside (inner#1844). */
export interface MediaPlayerHandle {
  /** Where the player stands now. */
  read: () => MediaPlayerState;
  /** Pause it. */
  pause: () => void;
  /** Move it to a time and set its sound, leaving it paused or playing as it is. */
  apply: (state: MediaPlayerState) => void;
}

/** Actual resource notice plus an independently React-owned overlay host. */
export interface MediaPlayerVideoSnapshot extends MediaSurfaceSnapshot { sourceBinding?: VideoPresentationSourceBinding }

export interface MediaPlayerProps {
  /** The handle a full-screen view reads and writes the player through. */
  ref?: React.Ref<MediaPlayerHandle>;
  /** Where to start: a full-screen view goes on from its source player. */
  start?: MediaPlayerState;
  /**
   * The selected version to play; null while there is none, when the original plays for display only (frames-split §7.8
   * detached × Attach) and a publish swaps to the version keeping time and play or pause (§7.9 T).
   */
  videoSource?: VideoPresentationSource | null;
  /** The candidate's state while nothing is selected, shown over the original (§7.9 last paragraph). */
  preparation?: VideoPreparationState;
  /** Whether this resource is currently displayed. */
  active?: boolean;
  /** Actual source transport lifecycle, never persisted in node data. */
  onVideoBinding?: (snapshot: MediaPlayerVideoSnapshot) => void;
  /** Synchronous actual-frame consumer. */
  onPresentedFrame?: (frame: PresentedMediaFrame) => void;
  /** Existing tool overlays sharing the displayed canonical box. */
  children?: React.ReactNode;
  /** Which media kind to render. */
  modality: 'audio' | 'video';
  /** Media source URL (the permanent public `adapter.publicUrl` value). */
  src: string;
  /** Poster image (video only). */
  poster?: string;
  /** Show the poster's original, not its preview: the canvas has zoomed this node past it. */
  fullPoster?: boolean;
  /**
   * The video's own size, when the node knows it (inner#1320). The box is
   * reserved from it before anything loads, and the skeleton covers it until
   * the poster or the first frame arrives.
   */
  size?: { width: number; height: number };
  /**
   * The running time the ledger measured when this file was stored, if any.
   * It is on the node before the media is fetched, so the scrubber reads the
   * real time straight away instead of "0:00" until enough has decoded.
   */
  duration?: number;
  /**
   * `'full'` (default) — the player with volume.
   * `'preview'` (#1622) — the hover-preview player: play + seek only, no
   * volume popover. The volume is a portaled Popover, a DOM sibling of the
   * card, so moving to it would leave the HoverCard.
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
  /** Optional document-owned physical control surface. */
  videoControls?: VideoControlsTarget;
  /**
   * Opens Extract frames on this video in the chosen mode (tools design §4 camera menu); with it the full video player shows
   * a camera menu on hover.
   */
  onPickFrame?: (mode: FrameMode) => void;
}

/** The frames the camera menu offers. */
export type FrameMode = 'first' | 'last' | 'current';
const FRAME_MODES: readonly FrameMode[] = ['first', 'last', 'current'];

/**
 * The camera menu at the end of the video control bar: First, Last and Current frame.
 * @param props - The button classes and the pick handler.
 * @param props.className - The control bar's button classes.
 * @param props.onPickFrame - Reports the chosen frame.
 * @returns The menu.
 * @throws {never} Never.
 */
function FrameCaptureMenu(props: { className: string; onPickFrame: (mode: FrameMode) => void }): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(open);
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger asChild>
      <Button type='button' variant={null} size={null} aria-label={t('canvas.miniTool.video.extract-frames.label')} data-testid='frame-capture-menu'
        className={`${props.className} opacity-0 group-hover/player:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100`}>
        <Camera className='h-4 w-4' />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align='end' side='top' sideOffset={8} avoidCollisions={false} className='nodrag'>
      {FRAME_MODES.map((mode) => <DropdownMenuItem key={mode} onSelect={() => props.onPickFrame(mode)}>{t(`canvas.miniTool.videoUI.${mode}`)}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/**
 * The control bar's buttons, at the shared inline-button size.
 *
 * Written as the token rather than the 28px it currently resolves to: these
 * are the same kind of button as the ones in the chrome, and a size stated as
 * a number is one the next change to that scale leaves behind.
 */
const BUTTON_SIZE = 'h-[var(--btn-inline)] w-[var(--btn-inline)]';

/** Where the off-screen load of an original cover stands. */
type CoverOutcome = 'loading' | 'loaded' | 'failed';

/**
 * Loads an original cover off-screen and reports how it went.
 * @param url - The original cover's address, or nothing when none is wanted.
 * @returns 'loaded' when there is nothing to load.
 */
function useOriginalCover(url: string | undefined): CoverOutcome {
  const [settled, setSettled] = React.useState<{ url: string; outcome: CoverOutcome } | null>(null);
  React.useEffect(() => {
    if (url === undefined) return undefined;
    const image = new Image();
    image.onload = (): void => setSettled({ url, outcome: 'loaded' });
    image.onerror = (): void => setSettled({ url, outcome: 'failed' });
    image.src = url;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);
  if (url === undefined) return 'loaded';
  return settled?.url === url ? settled.outcome : 'loading';
}

/**
 * Unified canvas media player built on a native `<audio>`/`<video>` element +
 * {@link useMediaPlayer}. Sliders are div-based {@link Slider} (Radix) so they
 * render identically across browsers; volume lives in a click-popover vertical
 * slider so it never eats the control-bar width. Video controls overlay the
 * picture bottom (the video fills the node); audio controls sit below the
 * decorative {@link Waveform}, which doubles as the seek surface. Every
 * interactive control carries `nodrag` so ReactFlow does not hijack drags,
 * and the sliders carry `nokey` so arrow keys move the playhead or volume
 * rather than the node.
 * Zero third-party player dependency.
 * @param root0 - Component props.
 * @param root0.ref - The handle a full-screen view reads and writes the player through.
 * @param root0.start - Where to start.
 * @param root0.videoSource - The selected version; null plays the original for display only.
 * @param root0.preparation - The candidate's state while nothing is selected.
 * @param root0.active - Whether this resource is displayed.
 * @param root0.onVideoBinding - Actual resource and independent overlay target.
 * @param root0.onPresentedFrame - Synchronous canonical frame consumer.
 * @param root0.children - Tool overlays in the same canonical display box.
 * @param root0.modality - `'audio'` or `'video'`.
 * @param root0.src - Media source URL.
 * @param root0.poster - Poster image (video only).
 * @param root0.fullPoster - Show the poster's original, not its preview.
 * @param root0.size - The video's own size, which reserves the box.
 * @param root0.duration - The running time the ledger measured, if any.
 * @param root0.variant - `'full'` (default) or `'preview'` (hover preview: no volume).
 * @param root0.onDimensions - Reports the video's intrinsic pixel size on metadata load (video only).
 * @param root0.controlsHidden - Slide the control bar out and make it unreachable (video only, #1987).
 * @param root0.videoControls - The document-owned control destination and interaction callbacks.
 * @param root0.onPickFrame - Opens Extract frames in the chosen mode; shows the camera menu on the full player.
 * @returns The media player element.
 */
export function MediaPlayer({
  ref: handleRef,
  start,
  modality,
  src,
  videoSource,
  preparation,
  active = true,
  onVideoBinding,
  onPresentedFrame,
  children,
  poster,
  fullPoster = false,
  size,
  duration,
  onDimensions,
  variant = 'full',
  controlsHidden = false,
  videoControls,
  onPickFrame,
}: MediaPlayerProps): React.JSX.Element {
  const ref = React.useRef<HTMLMediaElement>(null);

  const isVideo = modality === 'video';
  const ownsVideo = isVideo && videoSource != null;
  const key = videoSource ? runtimeSourceKeyOf(videoSource) : JSON.stringify([src, null]);
  const wanted = React.useRef({ key, active });
  wanted.current = { key, active };
  const consumers = React.useRef({ onVideoBinding, onPresentedFrame, onDimensions });
  consumers.current = { onVideoBinding, onPresentedFrame, onDimensions };
  const handoff = React.useRef<{ src: string; time: number; playing: boolean } | null>(null);
  const previousElement = React.useRef<HTMLVideoElement | null>(null);
  const adapted = React.useRef<{ original: MediaSurfaceBinding; binding: MediaSurfaceBinding } | null>(null);
  const [notice, setNotice] = React.useState<{ key: string; value: MediaSurfaceSnapshot } | null>(null);
  /**
   * Adapts only the current actual owner and preserves the node's native sound settings.
   * @param value - Current effect-owned presentation state.
   * @throws {never} Never.
   */
  const acceptBinding = React.useCallback((value: MediaSurfaceSnapshot): void => {
    if (wanted.current.key !== key) return;
    if (value.binding !== null && (!wanted.current.active || value.binding.sourceKey !== key)) return;
    let binding: MediaSurfaceBinding | null = null;
    if (value.binding !== null) {
      const original = value.binding;
      if (previousElement.current !== original.element) {
        if (previousElement.current !== null) { original.element.volume = previousElement.current.volume; original.element.muted = previousElement.current.muted; }
        previousElement.current = original.element;
      }
      bindVideoDisplay(original.surface, original.element, src);
      original.surface.setAttribute('data-testid', 'media-element');
      if (adapted.current?.original !== original) {
        const owned: MediaSurfaceBinding = {
          ...original,
          seek: (time) => {
            if (adapted.current?.original !== original || wanted.current.key !== key) return;
            original.seek(time);
            consumers.current.onVideoBinding?.({ status: 'ready', binding: owned, error: null });
          },
        };
        adapted.current = { original, binding: owned };
      }
      binding = adapted.current.binding;
      // A publish over the original for display keeps where the user was and whether they were playing (§7.9 T).
      const carried = handoff.current;
      if (carried !== null && carried.src === src) {
        handoff.current = null;
        original.seek(carried.time);
        if (carried.playing) void original.play().catch(() => undefined);
      }
      consumers.current.onDimensions?.({ width: original.original.width, height: original.original.height });
    } else adapted.current = null;
    const next = { ...value, binding };
    setNotice((before) => before?.key === key && before.value.status === next.status && before.value.binding === next.binding && before.value.error === next.error ? before : { key, value: next });
    consumers.current.onVideoBinding?.(next);
  }, [key, src]);
  /**
   * Delivers just-drawn pixels before the renderer's buffer can clear.
   * @param frame - Actual current source and seek frame.
   * @throws {never} Consumers own pixel-read failures.
   */
  const acceptFrame = React.useCallback((frame: PresentedMediaFrame): void => {
    if (wanted.current.active && frame.sourceKey === wanted.current.key) consumers.current.onPresentedFrame?.(frame);
  }, []);
  const snapshot = notice?.key === key && active ? notice.value : null;
  const binding = snapshot?.binding ?? null;
  const p = useMediaPlayer(ref, duration, start, ownsVideo ? binding : undefined);
  // A presented video is read and moved through its owned element; the native ref is the original's.
  React.useImperativeHandle(handleRef, () => ({
    read: () => {
      const el = binding?.element ?? ref.current;
      return el
        ? { time: el.currentTime, playing: !el.paused, muted: el.muted, volume: el.volume }
        : { time: 0, playing: false, muted: false, volume: 1 };
    },
    pause: () => {
      if (binding) binding.pause();
      else ref.current?.pause();
    },
    apply: (state) => {
      if (binding) {
        binding.seek(state.time);
        binding.element.muted = state.muted;
        binding.element.volume = state.volume;
        return;
      }
      const el = ref.current;
      if (el) writePlayerState(el, state);
    },
  }), [binding]);
  const unavailable = ownsVideo && binding === null;
  const displaysOriginal = isVideo && videoSource === null;
  React.useEffect(() => {
    if (displaysOriginal) handoff.current = { src, time: p.currentTime, playing: p.playing };
  }, [displaysOriginal, src, p.currentTime, p.playing]);
  const [originalFailedFor, setOriginalFailedFor] = React.useState<string | null>(null);
  const t = useTranslation();
  const pointer = useSeekPointer(p.seekFraction, videoControls);
  React.useLayoutEffect(() => {
    if (controlsHidden) pointer.capture.current?.release();
  }, [controlsHidden, pointer.capture]);
  const [inlineControls, setInlineControls] = React.useState<HTMLDivElement | null>(null);
  const themedControls = videoControls?.surface === 'popover';
  // Zoomed past the cover preview, the original cover is loaded off-screen (a
  // poster has no load or error event of its own). Until it arrives the
  // stretched preview is hidden under the skeleton; a cover that fails gives
  // the poster back its preview (inner#1472).
  const coverOutcome = useOriginalCover(fullPoster ? poster : undefined);
  const showsOriginalCover = fullPoster && coverOutcome !== 'failed';
  // A poster has no error event of its own, so the cover's preview is tried
  // off-screen and the original stands in when it is missing (inner#1320).
  const shownPoster =
    usePreviewSrc(poster, { probe: true, enabled: !showsOriginalCover }).src ?? undefined;
  // The poster's preview has loaded once its width is recorded; the video's
  // own data ends the wait for a poster that has none.
  const posterLoaded = usePreviewWidth(poster) !== null;
  const [frameFor, setFrameFor] = React.useState<string | null>(null);
  const loading = size !== undefined && !posterLoaded && frameFor !== src;
  // The poster shows until the video first plays (HTML's "show poster" flag);
  // after that the element paints the video's own frames.
  const [startedFor, setStartedFor] = React.useState<string | null>(null);
  const awaitsCover = showsOriginalCover && coverOutcome === 'loading' && startedFor !== src;
  // Under the skeleton the video is hidden: a half-loaded or stretched poster
  // would show through it.
  const covered = loading || awaitsCover;
  // #1622: the hover-preview variant drops volume (a portaled Popover) so it
  // can live inside an auto-close HoverCard.
  const showVolume = variant !== 'preview';
  // The times give way only in the full player, which shares its row with the
  // volume button; the preview row has room for them.
  const timeCls =
    variant === 'preview'
      ? 'shrink-0 text-2xs tabular-nums'
      : 'hidden shrink-0 text-2xs tabular-nums @min-[16rem]:inline';

  // Video controls on the video sit on a dark scrim (light-on-video); audio
  // controls, and video controls moved into a document popover
  // (`videoControls.surface === 'popover'`), sit on a themed surface and take
  // the themed hover and ring. On the scrim the glyphs are white because the control bar itself carries `text-white`
  // and these buttons ship `variant={null}`, so no variant colour is layered
  // over it.
  // The focus ring is the one thing the video branch has to restate. `Button`
  // rings in `--ring`, a themed colour read against a themed surface — and this
  // bar's surface is the video's own dark scrim in either theme, so in light
  // theme the ring is dark on dark and a keyboard user cannot see where they
  // are.
  const btnCls = `inline-flex ${BUTTON_SIZE} shrink-0 items-center justify-center rounded-chrome ${
    isVideo && !themedControls
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
      disabled={unavailable}
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
          disabled={unavailable}
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
          className='nokey h-24 text-foreground'
        />
      </PopoverContent>
    </Popover>
  );

  const videoControlsRow = (
    <div
      data-testid='controls'
      data-media-playback=''
      inert={controlsHidden}
      data-controls-surface={themedControls ? 'popover' : 'video'}
      onFocusCapture={() => { if (!pointer.migrating.current) videoControls?.onFocusChange?.(true, null); }}
      onBlurCapture={(event) => {
        if (!pointer.migrating.current && !event.currentTarget.contains(event.relatedTarget)) videoControls?.onFocusChange?.(false, event.relatedTarget);
      }}
      className={themedControls ? 'nodrag flex w-full items-center gap-2 px-2 py-1 text-popover-foreground' : `nodrag absolute z-10 inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-white transition-transform ${controlsHidden ? 'translate-y-full' : ''}`}
    >
      {playButton}
      <span
        data-testid='time-current'
        className={timeCls}
      >
        {formatSeconds(p.currentTime)}
      </span>
      <Slider
        data-testid='seek'
        disabled={unavailable}
        onPointerDown={pointer.onPointerDown}
        onPointerMove={pointer.onPointerMove}
        onPointerUp={pointer.onPointerUp}
        onPointerCancel={pointer.onPointerCancel}
        onLostPointerCapture={pointer.onLostPointerCapture}
        aria-label='Seek'
        min={0}
        max={100}
        step={0.1}
        value={[p.progress * 100]}
        onValueChange={([v]) => p.seekFraction(v / 100)}
        className={videoControls === undefined ? 'nokey min-w-0 flex-1' : 'nokey min-w-10 flex-1'}
      />
      <span
        data-testid='time-total'
        className={timeCls}
      >
        {formatSeconds(p.duration)}
      </span>
      {showVolume ? <span className='hidden @min-[11rem]:contents'>{volumeControl}</span> : null}
      {variant === 'full' && onPickFrame !== undefined ? <FrameCaptureMenu className={btnCls} onPickFrame={onPickFrame} /> : null}
    </div>
  );

  const controlsOverVideo = !controlsHidden && (videoControls === undefined || videoControls.destination === 'inline');
  const placedControls = videoControls === undefined ? videoControlsRow : (
    <>
      <div ref={setInlineControls} className='absolute inset-x-0 bottom-0' />
      <MediaControlsPortal
        destination={controlsHidden ? null : videoControls.destination === 'inline' ? inlineControls : videoControls.destination}
        capture={pointer.capture}
        migrating={pointer.migrating}
        preserveFocus={videoControls.preserveFocus}
      >{videoControlsRow}</MediaControlsPortal>
    </>
  );

  if (ownsVideo && videoSource != null) {
    const original = presentedSizeOf(videoSource.presentation);
    const loadingOwner = snapshot?.status !== 'ready';
    return <div className='group/player @container relative' data-testid='media-player' style={{ aspectRatio: `${original.width}/${original.height}` }}>
      <VideoPresentationSurface source={videoSource} active={active} onBinding={acceptBinding} onPresentedFrame={acceptFrame}>
        {loadingOwner && shownPoster ? <img src={shownPoster} alt='' className='pointer-events-none absolute inset-0 h-full w-full object-contain' /> : null}
        {loadingOwner && !posterLoaded ? <Skeleton data-testid='media-skeleton' className='pointer-events-none absolute inset-0 rounded-none' /> : null}
        {placedControls}
        {/* Overlays read data-controls to keep clear of the control bar while it covers the bottom of the video. */}
        <div data-testid='video-tool-overlay-host' data-controls={controlsOverVideo ? 'shown' : 'hidden'} className='group/media-overlay pointer-events-none absolute inset-0'>{children}</div>
        {snapshot?.status === 'failed' ? <p className='pointer-events-none absolute inset-0 grid place-content-center bg-card p-3 text-center text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.mediaError')}</p> : null}
      </VideoPresentationSurface>
    </div>;
  }

  if (isVideo) {
    return (
      // Sized as a container: narrower players drop the times, then the
      // volume, keeping play and seek (the breakpoints a
      // responsive Video.js or Plyr player uses the same way).
      <div className='group/player @container relative' data-testid='media-player'>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded asset; no caption track until caption authoring lands. */}
        <video
          ref={ref as React.RefObject<HTMLVideoElement>}
          src={src}
          poster={shownPoster}
          playsInline
          // Explicit contract — the spec leaves the missing-value default to
          // the UA. Metadata covers the duration display + dimension badge
          // without downloading the full file per node (#1772).
          preload='metadata'
          data-testid='media-element'
          width={size?.width}
          height={size?.height}
          className={cn('block w-full', size !== undefined && 'h-auto', covered && 'opacity-0')}
          onPlay={() => setStartedFor(src)}
          onError={() => setOriginalFailedFor(src)}
          onLoadedData={() => setFrameFor(src)}
          onLoadedMetadata={(e) => {
            setFrameFor(src);
            const v = e.currentTarget;
            if (v.videoWidth > 0 && v.videoHeight > 0) {
              onDimensions?.({ width: v.videoWidth, height: v.videoHeight });
            }
          }}
        />
        {covered ? (
          <Skeleton
            data-testid='media-skeleton'
            className='pointer-events-none absolute inset-0 rounded-none'
          />
        ) : null}
        {placedControls}
        {displaysOriginal && preparation !== undefined ? <VideoPreparationNotice {...preparation} originalFailed={originalFailedFor === src} poster={poster} /> : null}
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
          className='nokey min-w-0 flex-1'
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
