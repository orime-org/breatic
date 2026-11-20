// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { FilmStrip } from '@web/spaces/canvas/mini-tool/FilmStrip';

/** The source player's live clock, which the strip reads every animation frame while the source plays. */
export interface VideoPlaybackLiveClock {
  /** The source player's element, whose play, pause and end start and stop the strip's reading. */
  element: HTMLVideoElement;
  /** The presented time now, null while no frame is shown. */
  read: () => number | null;
}

export interface VideoPlaybackStripProps {
  /** The source video. */
  src: string;
  /** The strip's length in seconds. */
  duration: number;
  /** The source's width over its height. */
  aspect: number;
  /** The source player's presented time, null while no frame is shown. */
  presentedTime: number | null;
  /** Lets the head and the middle label follow playback, which the panel does not re-render for. */
  liveClock?: VideoPlaybackLiveClock;
  /** Seeks the source player; without it the strip only shows. */
  onSeek?: (time: number) => void;
  /** Marks drawn on the strip above the filmstrip, such as split's cut handles. */
  children?: React.ReactNode;
}

/**
 * Seconds as the strip's labels write them.
 * @param seconds - The time.
 * @returns The label.
 * @throws {never} Never.
 */
export function secondsLabel(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(2)} s`;
}

/**
 * A share of the strip's length as a CSS percentage.
 * @param seconds - The time.
 * @param duration - The strip's length.
 * @returns The percentage.
 * @throws {never} Never.
 */
function percent(seconds: number, duration: number): string {
  return `${duration > 0 ? Math.max(0, Math.min(1, seconds / duration)) * 100 : 0}%`;
}

/**
 * The time the strip shows: the live clock read every animation frame while the source plays, otherwise the given
 * presented time, so only the strip re-renders per frame and the panel keeps its pause-and-seek cadence.
 * @param clock - The source player's live clock.
 * @param presentedTime - The presented time the panel last rendered with.
 * @returns The time to show, null while no frame is shown.
 * @throws {never} Never.
 */
export function useShownTime(clock: VideoPlaybackLiveClock | undefined, presentedTime: number | null): number | null {
  // undefined while not following playback.
  const [live, setLive] = React.useState<number | null | undefined>(undefined);
  React.useEffect(() => {
    if (clock === undefined) return undefined;
    const { element, read } = clock;
    let frame: number | null = null;
    /**
     * Reads the clock and asks for the next frame.
     * @throws {never} Never.
     */
    const step = (): void => { frame = requestAnimationFrame(step); setLive(read()); };
    /**
     * Follows playback from the next frame unless already following or paused.
     * @throws {never} Never.
     */
    const start = (): void => { if (frame === null && !element.paused) frame = requestAnimationFrame(step); };
    /**
     * Stops following and hands the head back to the given presented time.
     * @throws {never} Never.
     */
    const stop = (): void => { if (frame !== null) cancelAnimationFrame(frame); frame = null; setLive(undefined); };
    const starts = ['play', 'playing'];
    const stops = ['pause', 'ended'];
    for (const event of starts) element.addEventListener(event, start);
    for (const event of stops) element.addEventListener(event, stop);
    start();
    return () => {
      for (const event of starts) element.removeEventListener(event, start);
      for (const event of stops) element.removeEventListener(event, stop);
      stop();
    };
  }, [clock]);
  return live === undefined ? presentedTime : live;
}

/**
 * The source's filmstrip with the shared playhead (demo video-controls.tsx PlaybackStrip): pressing the strip seeks the
 * source player, and the row below reads the start, the current time and the end.
 * @param props - The source, its clock and the seek command.
 * @returns The strip.
 * @throws {never} Never.
 */
export function VideoPlaybackStrip(props: VideoPlaybackStripProps): React.JSX.Element {
  const { src, duration, aspect, onSeek, children } = props;
  const presentedTime = useShownTime(props.liveClock, props.presentedTime);
  const track = React.useRef<HTMLDivElement>(null);
  /**
   * Seeks to the pressed place on the strip as it is laid out on screen.
   * @param event - The press.
   * @throws {never} Never.
   */
  const seekAt = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || onSeek === undefined || track.current === null) return;
    const box = track.current.getBoundingClientRect();
    if (box.width <= 0) return;
    onSeek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * duration);
  };
  return <div className='nodrag nowheel grid gap-1.5' data-testid='video-playback-strip'>
    <div ref={track} data-testid='video-playback-track' className='relative h-12 select-none overflow-hidden rounded-chrome border border-border bg-muted' onPointerDown={seekAt}>
      <FilmStrip src={src} duration={duration} aspect={aspect} />
      {presentedTime === null ? null : <span data-testid='video-playback-head' className='pointer-events-none absolute inset-y-0 border-l border-primary' style={{ left: percent(presentedTime, duration) }}><span className='absolute -left-1 top-0 size-2 bg-primary' /></span>}
      {children}
    </div>
    <div data-testid='video-playback-times' className='flex justify-between text-xs tabular-nums text-muted-foreground'>
      <span>{secondsLabel(0)}</span><span>{presentedTime === null ? '' : secondsLabel(presentedTime)}</span><span>{secondsLabel(duration)}</span>
    </div>
  </div>;
}
