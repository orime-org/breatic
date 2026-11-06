// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

/** Where a player stands: what one player hands another (inner#1844). */
export interface MediaPlayerState {
  /** Playback position, seconds. */
  time: number;
  /** Whether it is playing. */
  playing: boolean;
  /** Whether it is muted. */
  muted: boolean;
  /** Volume, 0..1. */
  volume: number;
}

/** Reactive transport state + imperative actions for a native media element. */
export interface MediaPlayerApi {
  /** Whether the element is currently playing. */
  playing: boolean;
  /** Current playback position, seconds. */
  currentTime: number;
  /** Total duration, seconds (0 until metadata loads). */
  duration: number;
  /** Volume, 0..1. */
  volume: number;
  /** Whether the element is muted. */
  muted: boolean;
  /** Played fraction, `currentTime / duration`, 0..1 (0 when no duration). */
  progress: number;
  /** Play if paused, pause if playing. */
  togglePlay: () => void;
  /** Seek to an absolute time, seconds. */
  seek: (time: number) => void;
  /** Seek to a fraction of the duration, 0..1 (clicking the waveform / scrubber). */
  seekFraction: (fraction: number) => void;
  /** Set volume, 0..1 (clamped). */
  setVolumeLevel: (volume: number) => void;
  /** Toggle mute. */
  toggleMute: () => void;
}

/**
 * Drives a native `<audio>`/`<video>` element from React: mirrors its transport
 * state (playing / time / duration / volume / muted) into React state and
 * exposes imperative actions. All event listeners are attached AND removed in a
 * single effect, so React 19 StrictMode's double-mount neither leaks listeners
 * nor double-binds them.
 * @param ref - Ref to the media element this player drives.
 * @param knownDuration - What the ledger measured when the file was stored, if
 *   anything. It is on the node before a byte of media is fetched, so the
 *   scrubber reads the real running time immediately — and it is read on every
 *   render, because a task can replace the medium on a node that is already
 *   mounted and the new clip's duration arrives in the same write as its
 *   content. The element is what answers for a medium the node knows none of.
 * @param start - Where to start, written once at mount (inner#1844).
 * @returns Reactive player state plus transport actions.
 */
export function useMediaPlayer(
  ref: React.RefObject<HTMLMediaElement | null>,
  knownDuration?: number,
  start?: MediaPlayerState,
): MediaPlayerApi {
  const [playing, setPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [elementDuration, setElementDuration] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);

  // A hidden Space keeps its media element, and an element left playing goes
  // on sounding from a Space nobody is looking at. Empty deps: this runs when
  // the Space is hidden or closed, not when the caller hands in a new ref.
  React.useEffect(() => {
    const el = ref.current;
    return () => el?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Written in the commit of the click that opened this player, before any
  // metadata: a time set at HAVE_NOTHING becomes the start position, and play()
  // still counts as answering the click, which Safari requires for sound.
  // Mount only: a later `start` belongs to a player that has moved on.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !start) return;
    el.currentTime = start.time;
    el.muted = start.muted;
    el.volume = start.volume;
    if (start.playing) void el.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    /** Mirror the current native state, including a resource load/reset. */
    const sync = (): void => {
      setPlaying(!el.paused);
      setCurrentTime(el.currentTime);
      setElementDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setVolume(el.volume);
      setMuted(el.muted);
    };
    // Loading a new src resets paused without requiring a pause event. Read
    // the element rather than event names: queued events can describe an old
    // resource or a transport action that has already been superseded.
    const events = [
      'play', 'pause', 'ended', 'emptied', 'loadstart',
      'timeupdate', 'loadedmetadata', 'durationchange', 'volumechange',
    ];
    sync();
    for (const event of events) el.addEventListener(event, sync);
    return () => {
      for (const event of events) el.removeEventListener(event, sync);
    };
  }, [ref]);

  // A click can arrive before the queued native event updates React.
  const togglePlay = React.useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, [ref]);

  const seek = React.useCallback(
    (time: number): void => {
      const el = ref.current;
      if (el) el.currentTime = time;
    },
    [ref],
  );

  // The node's own figure comes first, and the element answers for a medium the
  // node knows none of.
  const duration = knownDuration ?? elementDuration;

  const seekFraction = React.useCallback(
    (fraction: number): void => {
      const el = ref.current;
      if (el && duration > 0) {
        el.currentTime = Math.min(1, Math.max(0, fraction)) * duration;
      }
    },
    [ref, duration],
  );

  const setVolumeLevel = React.useCallback(
    (next: number): void => {
      const el = ref.current;
      if (el) el.volume = Math.min(1, Math.max(0, next));
    },
    [ref],
  );

  const toggleMute = React.useCallback((): void => {
    const el = ref.current;
    if (el) el.muted = !el.muted;
  }, [ref]);

  // The same figure the scrubber is positioned against, so a drag lands where
  // it was released. The element takes a time before it has any metadata: with
  // `readyState` at HAVE_NOTHING it keeps the write as the default playback
  // start position and honours it once the medium loads.
  const progress = duration > 0 ? currentTime / duration : 0;

  return {
    playing,
    currentTime,
    duration,
    volume,
    muted,
    progress,
    togglePlay,
    seek,
    seekFraction,
    setVolumeLevel,
    toggleMute,
  };
}
