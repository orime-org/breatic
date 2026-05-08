/**
 * Hidden `<audio>` transport for canvas audio nodes — exposes the same imperative surface as {@link VideoRef}
 * so playback chrome ({@link PlaybackPanel}) can share code with video nodes.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { VideoPlaybackSnapshot, VideoRef } from '@/new/project/components/canvas/common/CanvasVideo';

export interface CanvasAudioProps {
  /** Audio URL (blob or remote). */
  src: string;
  /** Fired when time, duration, play state, or volume changes. */
  onPlaybackUpdate?: (snapshot: VideoPlaybackSnapshot) => void;
  className?: string;
}

const snapshotFromElement = (audio: HTMLAudioElement): VideoPlaybackSnapshot => ({
  currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
  duration: Number.isFinite(audio.duration) ? audio.duration : 0,
  isPlaying: !audio.paused,
  volume: Number.isFinite(audio.volume) ? audio.volume : 1,
});

const CanvasAudio = forwardRef<VideoRef, CanvasAudioProps>(function CanvasAudio(
  { src, onPlaybackUpdate, className },
  ref,
) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previousVolumeRef = useRef(1);
  const emitPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !onPlaybackUpdate) return;
    onPlaybackUpdate(snapshotFromElement(audio));
  }, [onPlaybackUpdate]);

  useImperativeHandle(
    ref,
    () => ({
      getCurrentTime: () => {
        const audio = audioRef.current;
        if (!audio) return 0;
        return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      },
      getDuration: () => {
        const audio = audioRef.current;
        if (!audio) return 0;
        const d = audio.duration;
        return Number.isFinite(d) ? d : 0;
      },
      setCurrentTime: (seconds: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
        const next = dur > 0 ? Math.min(Math.max(0, seconds), dur) : Math.max(0, seconds);
        audio.currentTime = next;
        emitPlayback();
      },
      getPlaybackRate: () => {
        const audio = audioRef.current;
        if (!audio) return 1;
        const r = audio.playbackRate;
        return Number.isFinite(r) ? r : 1;
      },
      setPlaybackRate: (rate: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.playbackRate = Math.max(0.25, Math.min(4, rate));
      },
      play: () => {
        const audio = audioRef.current;
        if (!audio) return;
        void audio.play().catch(() => {});
        emitPlayback();
      },
      pause: () => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.pause();
        emitPlayback();
      },
      isPlaying: () => {
        const audio = audioRef.current;
        return audio ? !audio.paused : false;
      },
      setVolume: (value: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        const v = Math.max(0, Math.min(1, value));
        audio.volume = v;
        if (v > 0) previousVolumeRef.current = v;
        emitPlayback();
      },
      toggleMute: () => {
        const audio = audioRef.current;
        if (!audio) return;
        const vol = audio.volume;
        if (vol === 0) {
          const restore = previousVolumeRef.current > 0 ? previousVolumeRef.current : 0.5;
          audio.volume = restore;
          previousVolumeRef.current = restore;
        } else {
          previousVolumeRef.current = vol;
          audio.volume = 0;
        }
        emitPlayback();
      },
      getHtmlVideoElement: () => null,
    }),
    [emitPlayback],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onMeta = () => emitPlayback();
    const onTime = () => emitPlayback();
    const onPlay = () => emitPlayback();
    const onPause = () => emitPlayback();
    const onEnded = () => emitPlayback();
    const onVolume = () => emitPlayback();

    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('volumechange', onVolume);

    return () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('volumechange', onVolume);
    };
  }, [emitPlayback]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = src;
    audio.load();
    emitPlayback();
  }, [emitPlayback, src]);

  return (
    <audio
      ref={audioRef}
      className={className ?? 'sr-only'}
      preload='auto'
      aria-hidden
    />
  );
});

export default CanvasAudio;
