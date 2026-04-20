import React, { memo } from 'react';
import { Icon } from '@/components/base/icon';
import Slider from '@/components/base/slider';
import Tooltip from '@/components/base/tooltip';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';

const formatPlaybackTime = (seconds: number) => {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const PLAYBACK_PANEL_ICON = '#383838';

/** Track + thumb styling aligned with `MultiAngleBottomToolbar` sliders */
const MULTI_ANGLE_SLIDER_CHROME = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;

export type PlaybackToolbarProps = {
  videoRef: React.RefObject<VideoRef | null>;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  /** 0–100: ruler horizontal scale (driven by parent, affects timeline width). */
  timelineZoom: number;
  onTimelineZoomChange: (value: number) => void;
  onFullscreen: () => void;
};

const PlaybackToolbar: React.FC<PlaybackToolbarProps> = ({
  videoRef,
  currentTime,
  duration,
  isPlaying,
  volume,
  timelineZoom,
  onTimelineZoomChange,
  onFullscreen,
}) => {
  const handlePlayPause = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.isPlaying()) v.pause();
    else v.play();
  };

  const seekBy = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const dur = v.getDuration?.() ?? duration;
    const next = Math.min(Math.max(0, v.getCurrentTime() + delta), dur > 0 ? dur : 0);
    v.setCurrentTime?.(next);
  };

  const handleMuteToggle = () => {
    const v = videoRef.current;
    if (!v) return;
    v.toggleMute?.();
  };

  const icon = PLAYBACK_PANEL_ICON;

  return (
    <div className='flex min-w-0 items-center gap-0.5 overflow-x-auto'>
      <Tooltip title='Fullscreen' placement='top' offset={4}>
        <button
          type='button'
          className='flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-black/5'
          aria-label='Fullscreen'
          onClick={onFullscreen}
        >
          <Icon name='videoNode-fullscreen' width={14} height={14} color={icon} />
        </button>
      </Tooltip>
      <div className='flex min-w-0 flex-1 items-center justify-center gap-0.5'>
        <Tooltip title='Skip back 5 seconds' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-7 w-7 items-center justify-center rounded hover:bg-black/5'
            aria-label='Skip back'
            onClick={() => seekBy(-5)}
          >
            <Icon name='videoNode-playback-skip-back' width={17} height={10} color={icon} />
          </button>
        </Tooltip>
        <Tooltip title='Step back one frame' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-7 w-7 items-center justify-center rounded hover:bg-black/5'
            aria-label='Step back'
            onClick={() => seekBy(-1 / 30)}
          >
            <Icon name='videoNode-playback-step-back' width={9} height={11} color={icon} />
          </button>
        </Tooltip>
        <Tooltip title={isPlaying ? 'Pause' : 'Play'} placement='top' offset={4}>
          <button
            type='button'
            className='flex h-8 w-8 items-center justify-center rounded hover:bg-black/5'
            aria-label={isPlaying ? 'Pause' : 'Play'}
            onClick={handlePlayPause}
          >
            {isPlaying ? (
              <Icon name='project-pause-audio-icon' width={12} height={12} color={icon} />
            ) : (
              <Icon name='videoNode-playback-play' width={16} height={16} color={icon} />
            )}
          </button>
        </Tooltip>
        <Tooltip title='Current time / duration' placement='top' offset={4}>
          <span className='min-w-0 shrink-0 cursor-default whitespace-nowrap text-center text-[10px] tabular-nums text-text-default-secondary'>
            {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
          </span>
        </Tooltip>
        <Tooltip title='Step forward one frame' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-7 w-7 items-center justify-center rounded hover:bg-black/5'
            aria-label='Step forward'
            onClick={() => seekBy(1 / 30)}
          >
            <Icon name='videoNode-playback-step-forward' width={9} height={11} color={icon} />
          </button>
        </Tooltip>
        <Tooltip title='Skip forward 5 seconds' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-7 w-7 items-center justify-center rounded hover:bg-black/5'
            aria-label='Skip forward'
            onClick={() => seekBy(5)}
          >
            <Icon name='videoNode-playback-skip-forward' width={17} height={10} color={icon} />
          </button>
        </Tooltip>
      </div>
      <div className='flex h-7 shrink-0 items-center gap-1'>
        <Tooltip title='Zoom timeline out' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-7 w-7 items-center justify-center rounded hover:bg-black/5'
            aria-label='Zoom timeline out'
            onClick={() => onTimelineZoomChange(Math.max(0, timelineZoom - 10))}
          >
            <Icon name='videoNode-zoom-out' width={16} height={16} color={icon} />
          </button>
        </Tooltip>
        <div className='flex h-7 w-[100px] shrink-0 items-center justify-center px-0.5'>
          <Slider
            className='nodrag !m-0 !w-full'
            min={0}
            max={100}
            step={1}
            value={timelineZoom}
            onChange={onTimelineZoomChange}
            {...MULTI_ANGLE_SLIDER_CHROME}
          />
        </div>
        <Tooltip title='Zoom timeline in' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-7 w-7 items-center justify-center rounded hover:bg-black/5'
            aria-label='Zoom timeline in'
            onClick={() => onTimelineZoomChange(Math.min(100, timelineZoom + 10))}
          >
            <Icon name='videoNode-zoom-in' width={16} height={16} color={icon} />
          </button>
        </Tooltip>
        <Tooltip title={volume === 0 ? 'Unmute' : 'Mute'} placement='top' offset={4}>
          <button
            type='button'
            className='flex h-7 w-7 items-center justify-center rounded hover:bg-black/5'
            aria-label={volume === 0 ? 'Unmute' : 'Mute'}
            onClick={handleMuteToggle}
          >
            {volume === 0 ? (
              <Icon name='project-mute-icon' width={14} height={14} color={icon} />
            ) : (
              <Icon name='videoNode-playback-volume' width={16} height={15} color={icon} />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  );
};

export default memo(PlaybackToolbar);
