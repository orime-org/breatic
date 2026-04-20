/**
 * Unified video component for the project: video.js + bottom control bar (play/pause, time, progress, volume).
 * Consistent with the control bar in PreviewVideo / VideoNodeContent; can be embedded in any container.
 */
import React, { memo, useRef, useState, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import Slider from '@/components/base/slider';
import { Icon } from '@/components/base/icon';

export type VideoPlaybackSnapshot = {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
};

export interface VideoProps {
  /** Video URL */
  src: string;
  /** Initial playback time (seconds) */
  initialTime?: number;
  /** Whether to auto-play */
  autoPlay?: boolean;
  /** Whether to show the bottom control bar */
  showControlBar?: boolean;
  /** Fired when time, duration, play state, or volume changes (e.g. external editor chrome) */
  onPlaybackUpdate?: (snapshot: VideoPlaybackSnapshot) => void;
  /** Container class name */
  className?: string;
  /** Container style */
  style?: React.CSSProperties;
  /** Optional clip start time (seconds); when set, playback is constrained to this range. */
  clipStartTime?: number;
  /** Optional clip end time (seconds); when set with start, playback is constrained to this range. */
  clipEndTime?: number;
}

export interface VideoRef {
  getCurrentTime: () => number;
  getDuration: () => number;
  setCurrentTime: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  isPlaying: () => boolean;
  setVolume: (value: number) => void;
  toggleMute: () => void;
}

const getVideoMime = (url: string) => {
  const clean = url.split('?')[0].split('#')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'mov' || ext === 'qt') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  return 'video/mp4';
};

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const normalizeClipRange = (
  duration: number,
  clipStartTime?: number,
  clipEndTime?: number,
): { start: number; end: number; duration: number } | null => {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const hasStart = Number.isFinite(clipStartTime);
  const hasEnd = Number.isFinite(clipEndTime);
  if (!hasStart && !hasEnd) return null;
  const rawStart = hasStart ? Number(clipStartTime) : 0;
  const rawEnd = hasEnd ? Number(clipEndTime) : duration;
  const start = Math.min(Math.max(0, rawStart), duration);
  const end = Math.min(Math.max(0, rawEnd), duration);
  if (end - start <= 1e-3) return null;
  return { start, end, duration: end - start };
};

const Video = forwardRef<VideoRef, VideoProps>(
  (
    {
      src,
      initialTime,
      autoPlay = false,
      showControlBar = true,
      onPlaybackUpdate,
      className = '',
      style,
      clipStartTime,
      clipEndTime,
    },
    ref,
  ) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const playerRef = useRef<any>(null);
    const volumePopoverRef = useRef<HTMLDivElement | null>(null);
    const onPlaybackUpdateRef = useRef(onPlaybackUpdate);
    onPlaybackUpdateRef.current = onPlaybackUpdate;

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [progress, setProgress] = useState(0);
    const [volume, setVolume] = useState(1);
    const previousVolumeRef = useRef(1);
    const [showVolumeSlider, setShowVolumeSlider] = useState(false);
    const playbackRafRef = useRef<number | null>(null);

    const emitPlayback = useCallback(() => {
      const p = playerRef.current;
      const cb = onPlaybackUpdateRef.current;
      if (!p || !cb) return;
      const dur = p.duration();
      const range = normalizeClipRange(dur, clipStartTime, clipEndTime);
      const absCurrent = p.currentTime();
      const currentTime = range ? Math.min(Math.max(absCurrent - range.start, 0), range.duration) : absCurrent;
      cb({
        currentTime,
        duration: range ? range.duration : Number.isFinite(dur) ? dur : 0,
        isPlaying: !p.paused(),
        volume: typeof p.volume === 'function' ? p.volume() : 1,
      });
    }, [clipEndTime, clipStartTime]);

    const schedulePlaybackEmit = useCallback(() => {
      if (playbackRafRef.current != null) return;
      playbackRafRef.current = requestAnimationFrame(() => {
        playbackRafRef.current = null;
        emitPlayback();
      });
    }, [emitPlayback]);

    useEffect(() => {
      if (!onPlaybackUpdate || !playerRef.current) return;
      // When toolbar starts listening after metadata already loaded, emit once immediately.
      schedulePlaybackEmit();
    }, [onPlaybackUpdate, schedulePlaybackEmit, src, clipStartTime, clipEndTime]);

    const handleVolumeMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
      const next = e.relatedTarget as Node | null;
      if (next && volumePopoverRef.current && volumePopoverRef.current.contains(next)) return;
      setShowVolumeSlider(false);
    };

    useImperativeHandle(
      ref,
      () => ({
        getCurrentTime: () => {
          if (!playerRef.current) return 0;
          const p = playerRef.current;
          const range = normalizeClipRange(p.duration(), clipStartTime, clipEndTime);
          const absCurrent = p.currentTime();
          return range ? Math.min(Math.max(absCurrent - range.start, 0), range.duration) : absCurrent;
        },
        getDuration: () => {
          const d = playerRef.current?.duration?.();
          const range = normalizeClipRange(d, clipStartTime, clipEndTime);
          return range ? range.duration : Number.isFinite(d) ? d : 0;
        },
        setCurrentTime: (seconds: number) => {
          if (!playerRef.current) return;
          const p = playerRef.current;
          const range = normalizeClipRange(p.duration(), clipStartTime, clipEndTime);
          const relative = Math.max(0, seconds);
          const next = range ? Math.min(range.start + relative, range.end) : relative;
          p.currentTime(next);
          emitPlayback();
        },
        play: () => {
          void playerRef.current?.play?.()?.catch(() => {});
          emitPlayback();
        },
        pause: () => {
          if (playerRef.current) playerRef.current.pause();
          emitPlayback();
        },
        isPlaying: () => (playerRef.current ? !playerRef.current.paused() : false),
        setVolume: (value: number) => {
          if (!playerRef.current) return;
          const v = Math.max(0, Math.min(1, value));
          playerRef.current.volume(v);
          if (v > 0) previousVolumeRef.current = v;
          emitPlayback();
        },
        toggleMute: () => {
          if (!playerRef.current) return;
          const p = playerRef.current;
          const vol = p.volume();
          if (vol === 0) {
            const restore = previousVolumeRef.current > 0 ? previousVolumeRef.current : 0.5;
            p.volume(restore);
            setVolume(restore);
            previousVolumeRef.current = restore;
          } else {
            previousVolumeRef.current = vol;
            p.volume(0);
            setVolume(0);
          }
          emitPlayback();
        },
      }),
      [clipEndTime, clipStartTime, emitPlayback],
    );

    useEffect(() => {
      const node = videoRef.current;
      if (!node) return;

      if (!playerRef.current) {
        playerRef.current = videojs(node, {
          controls: false,
          preload: 'auto',
          fluid: false,
          responsive: false,
        });
        playerRef.current.on('play', () => {
          setIsPlaying(true);
          emitPlayback();
        });
        playerRef.current.on('pause', () => {
          setIsPlaying(false);
          emitPlayback();
        });
        playerRef.current.on('ended', () => {
          setIsPlaying(false);
          emitPlayback();
        });
        playerRef.current.on('loadedmetadata', () => {
          const p = playerRef.current;
          const dur = p.duration();
          const range = normalizeClipRange(dur, clipStartTime, clipEndTime);
          setDuration(range ? range.duration : dur);
          const nextCurrent = range
            ? range.start + Math.max(0, Math.min(range.duration, initialTime ?? 0))
            : initialTime;
          if (nextCurrent !== undefined && playerRef.current) {
            playerRef.current.currentTime(nextCurrent);
            setCurrentTime(range ? nextCurrent - range.start : nextCurrent);
          }
          if (autoPlay && playerRef.current) {
            playerRef.current.play().catch(() => {});
          }
          emitPlayback();
        });
        playerRef.current.on('loadeddata', () => {
          const p = playerRef.current;
          const dur = p.duration();
          const range = normalizeClipRange(dur, clipStartTime, clipEndTime);
          const nextCurrent = range
            ? range.start + Math.max(0, Math.min(range.duration, initialTime ?? 0))
            : initialTime;
          if (nextCurrent !== undefined && playerRef.current) {
            playerRef.current.currentTime(nextCurrent);
            setCurrentTime(range ? nextCurrent - range.start : nextCurrent);
          }
          if (autoPlay && playerRef.current) {
            playerRef.current.play().catch(() => {});
          }
          emitPlayback();
        });
        playerRef.current.on('timeupdate', () => {
          const p = playerRef.current;
          const current = p.currentTime();
          const dur = p.duration();
          const range = normalizeClipRange(dur, clipStartTime, clipEndTime);
          if (range) {
            if (current >= range.end - 1e-3) {
              p.pause();
              p.currentTime(range.end);
              setIsPlaying(false);
              setCurrentTime(range.duration);
              setProgress(100);
              schedulePlaybackEmit();
              return;
            }
            const relativeCurrent = Math.min(Math.max(current - range.start, 0), range.duration);
            setCurrentTime(relativeCurrent);
            setDuration(range.duration);
            setProgress(range.duration > 0 ? (relativeCurrent / range.duration) * 100 : 0);
            schedulePlaybackEmit();
            return;
          }
          setCurrentTime(current);
          setDuration(Number.isFinite(dur) ? dur : 0);
          setProgress(dur > 0 ? (current / dur) * 100 : 0);
          schedulePlaybackEmit();
        });
        playerRef.current.on('volumechange', () => {
          const v = playerRef.current.volume();
          setVolume(v);
          if (v > 0) previousVolumeRef.current = v;
          emitPlayback();
        });
        playerRef.current.playbackRate(1);
      }

      if (src && playerRef.current) {
        playerRef.current.src({ src, type: getVideoMime(src) });
      }
    }, [src, initialTime, autoPlay, emitPlayback, schedulePlaybackEmit, clipStartTime, clipEndTime]);

    const handlePlayPause = () => {
      if (!playerRef.current) return;
      const p = playerRef.current;
      if (isPlaying) {
        p.pause();
        return;
      }
      const range = normalizeClipRange(p.duration(), clipStartTime, clipEndTime);
      if (range && p.currentTime() >= range.end - 1e-3) {
        p.currentTime(range.start);
      }
      p.play();
    };

    const handleProgressChange = (value: number) => {
      if (!playerRef.current) return;
      const p = playerRef.current;
      const range = normalizeClipRange(p.duration(), clipStartTime, clipEndTime);
      const newTime = range ? range.start + (value / 100) * range.duration : (value / 100) * duration;
      p.currentTime(newTime);
      setProgress(value);
    };

    const handleVolumeChange = (value: number) => {
      if (!playerRef.current) return;
      playerRef.current.volume(value);
      setVolume(value);
      if (value > 0) previousVolumeRef.current = value;
    };

    const handleMuteToggle = () => {
      if (!playerRef.current) return;
      if (volume === 0) {
        const restore = previousVolumeRef.current > 0 ? previousVolumeRef.current : 0.5;
        playerRef.current.volume(restore);
        setVolume(restore);
        previousVolumeRef.current = restore;
      } else {
        previousVolumeRef.current = volume;
        playerRef.current.volume(0);
        setVolume(0);
      }
    };

    const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

    return (
      <div
        className={`relative w-full h-full min-h-0 flex flex-col overflow-hidden rounded-[8px] bg-black ${className}`}
        style={style}
      >
        {/* Consistent with VideoDisplay: same container and video structure */}
        <div className='w-full h-full flex items-center justify-center'>
          <video
            ref={videoRef}
            className='video-js vjs-default-skin h-full w-full'
            data-setup='{}'
            style={{ backgroundColor: 'transparent' }}
          />
        </div>
        {showControlBar && (
          <div className='absolute bottom-0 left-0 right-0 z-10' onClick={stopPropagation}>
            <div className='pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-black/70' />
            <div className='relative flex items-center w-full gap-2 px-2 py-2'>
              <button
                type='button'
                onClick={handlePlayPause}
                className='flex-shrink-0 flex items-center justify-center w-8 h-8 text-white hover:opacity-80'
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? (
                  <Icon name='project-pause-audio-icon' width={10} height={10} color='#fff' />
                ) : (
                  <Icon name='project-play-audio-icon' width={10} height={10} color='#fff' />
                )}
              </button>
              <span className='flex-shrink-0 text-[12px] text-white font-normal tabular-nums'>
                {formatTime(currentTime)}
              </span>
              <div className='flex-1 min-w-0 flex items-center px-2 [&_.slider-container]:flex [&_.slider-container]:items-center [&_.slider-container]:w-full'>
                <Slider
                  min={0}
                  max={100}
                  step={0.1}
                  value={progress}
                  onChange={handleProgressChange}
                  className='!m-0 w-full nodrag'
                />
              </div>
              <span className='flex-shrink-0 text-[12px] text-white font-normal tabular-nums'>
                {formatTime(duration)}
              </span>
              <div
                className='relative flex-shrink-0 nodrag'
                onMouseEnter={() => setShowVolumeSlider(true)}
                onMouseLeave={handleVolumeMouseLeave}
              >
                <button
                  type='button'
                  onClick={handleMuteToggle}
                  className='flex items-center justify-center w-8 h-8 text-white hover:opacity-80'
                  aria-label={volume === 0 ? 'Unmute' : 'Mute'}
                >
                  {volume === 0 ? (
                    <Icon name='project-mute-icon' width={14} height={14} color='#fff' />
                  ) : (
                    <Icon name='project-volume-icon' width={14} height={14} color='#fff' />
                  )}
                </button>
                {showVolumeSlider && (
                  <div
                    ref={volumePopoverRef}
                    className='absolute bottom-full left-1/2 -translate-x-1/2 p-1.5 rounded bg-black/70 nodrag'
                  >
                    <div className='h-[60px] px-1'>
                      <Slider min={0} max={1} step={0.01} value={volume} onChange={handleVolumeChange} vertical />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
);

Video.displayName = 'Video';

export default memo(Video);
