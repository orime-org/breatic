// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

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
 * @returns Reactive player state plus transport actions.
 */
export function useMediaPlayer(
  ref: React.RefObject<HTMLMediaElement | null>,
): MediaPlayerApi {
  const [playing, setPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Sync any values already present before the first event fires.
    setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    setCurrentTime(el.currentTime);
    setVolume(el.volume);
    setMuted(el.muted);
    setPlaying(!el.paused);

    /** Mirror time / duration / volume / muted from the element into state. */
    const sync = (): void => {
      setCurrentTime(el.currentTime);
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setVolume(el.volume);
      setMuted(el.muted);
    };
    /**
     * Flip the playing flag from whichever transport event fired.
     * @param e - The `play` / `pause` / `ended` event.
     */
    const onTransport = (e: Event): void => {
      setPlaying(e.type === 'play');
    };

    el.addEventListener('play', onTransport);
    el.addEventListener('pause', onTransport);
    el.addEventListener('ended', onTransport);
    el.addEventListener('timeupdate', sync);
    el.addEventListener('loadedmetadata', sync);
    el.addEventListener('durationchange', sync);
    el.addEventListener('volumechange', sync);

    return () => {
      el.removeEventListener('play', onTransport);
      el.removeEventListener('pause', onTransport);
      el.removeEventListener('ended', onTransport);
      el.removeEventListener('timeupdate', sync);
      el.removeEventListener('loadedmetadata', sync);
      el.removeEventListener('durationchange', sync);
      el.removeEventListener('volumechange', sync);
    };
  }, [ref]);

  // Decide play vs pause from React's `playing` state (driven by the play/pause
  // events) — robust across browsers and matches the rendered control state.
  const togglePlay = React.useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play().catch(() => {});
  }, [ref, playing]);

  const seek = React.useCallback(
    (time: number): void => {
      const el = ref.current;
      if (el) el.currentTime = time;
    },
    [ref],
  );

  const seekFraction = React.useCallback(
    (fraction: number): void => {
      const el = ref.current;
      if (el && Number.isFinite(el.duration)) {
        el.currentTime = Math.min(1, Math.max(0, fraction)) * el.duration;
      }
    },
    [ref],
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

  const requestFullscreen = React.useCallback((): void => {
    const el = ref.current as
      | (HTMLMediaElement & { webkitRequestFullscreen?: () => void })
      | null;
    if (!el) return;
    // Standard API (Chrome / Edge / Firefox) + Safari-desktop webkit fallback.
    if (el.requestFullscreen) void el.requestFullscreen();
    else el.webkitRequestFullscreen?.();
  }, [ref]);

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
