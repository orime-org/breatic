// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { MediaSurfaceBinding } from '@web/spaces/canvas/video-presentation/types';

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
  /** Request fullscreen for the element (video). */
  requestFullscreen: () => void;
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
 * @param owned - An optional actual native or alpha transport owner.
 * @returns Reactive player state plus transport actions.
 */
export function useMediaPlayer(
  ref: React.RefObject<HTMLMediaElement | null>,
  knownDuration?: number,
  owned?: MediaSurfaceBinding | null,
): MediaPlayerApi {
  const [playing, setPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [elementDuration, setElementDuration] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);

  // A presentation owns its actual element; the original ref remains the
  // native audio/independent-player contract. Ref identity is irrelevant for
  // an owned transport and must not pause it on a control re-render.
  const nativeRef = owned === undefined ? ref : undefined;
  React.useEffect(() => {
    const el = owned?.element ?? nativeRef?.current;
    return () => {
      if (owned) owned.pause();
      else el?.pause();
    };
    // Native ref wrappers may change on render; only an actual owner change
    // ends this transport lifetime, matching the existing native mount contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owned]);

  React.useEffect(() => {
    const el = owned?.element ?? nativeRef?.current;
    if (!el) { setPlaying(false); setCurrentTime(0); setElementDuration(0); return undefined; }
    /**
     * Reads the current actual element, including resource reset events.
     * @throws {never} Never.
     */
    function sync(): void {
      setPlaying(!el!.paused);
      setCurrentTime(el!.currentTime);
      setElementDuration(Number.isFinite(el!.duration) ? el!.duration : 0);
      setVolume(el!.volume);
      setMuted(el!.muted);
    }
    const events = [
      'play', 'pause', 'ended', 'emptied', 'loadstart',
      'timeupdate', 'loadedmetadata', 'durationchange', 'volumechange',
    ];
    sync();
    for (const event of events) el.addEventListener(event, sync);
    return () => {
      for (const event of events) el.removeEventListener(event, sync);
    };
  }, [nativeRef, owned]);

  // A click can arrive before the queued native event updates React.
  const togglePlay = React.useCallback((): void => {
    const el = owned?.element ?? nativeRef?.current;
    if (!el) return;
    if (el.paused) void (owned ? owned.play() : el.play()).catch(() => {});
    else if (owned) owned.pause();
    else el.pause();
  }, [nativeRef, owned]);

  const seek = React.useCallback(
    (time: number): void => {
      const el = nativeRef?.current;
      if (owned) owned.seek(time);
      else if (el) el.currentTime = time;
    },
    [nativeRef, owned],
  );

  // The node's own figure comes first, and the element answers for a medium the
  // node knows none of.
  const duration = knownDuration ?? elementDuration;

  const seekFraction = React.useCallback(
    (fraction: number): void => {
      if (duration > 0) seek(Math.min(1, Math.max(0, fraction)) * duration);
    },
    [seek, duration],
  );

  const setVolumeLevel = React.useCallback(
    (next: number): void => {
      const el = owned?.element ?? nativeRef?.current;
      if (el) el.volume = Math.min(1, Math.max(0, next));
    },
    [nativeRef, owned],
  );

  const toggleMute = React.useCallback((): void => {
    const el = owned?.element ?? nativeRef?.current;
    if (el) el.muted = !el.muted;
  }, [nativeRef, owned]);

  const requestFullscreen = React.useCallback((): void => {
    const el = (owned?.container ?? nativeRef?.current) as
      | (HTMLElement & { webkitRequestFullscreen?: () => void })
      | null;
    if (!el) return;
    // Standard API (Chrome / Edge / Firefox) + Safari-desktop webkit fallback.
    if (el.requestFullscreen) void el.requestFullscreen();
    else el.webkitRequestFullscreen?.();
  }, [nativeRef, owned]);

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
    requestFullscreen,
  };
}
