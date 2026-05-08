import React, { memo, useEffect, useMemo, useState } from 'react';
import type { VideoRef } from '@/new/project/components/canvas/common/CanvasVideo';
import Slider from '@/components/base/slider';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import PlaybackPanel from '../playback/PlaybackPanel';
import {
  PLAYBACK_SPEED_DEFAULT,
  PLAYBACK_SPEED_MAX,
  PLAYBACK_SPEED_MIN,
  PLAYBACK_SPEED_STEP,
  formatPlaybackSpeed,
  roundPlaybackSpeedToStep,
} from '../playback/playbackSpeed';

export type SpeedBottomToolbarProps = {
  active: boolean;
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  /** Audio nodes: waveform timeline instead of ruler-only preview. */
  audioOnly?: boolean;
  onClose: () => void;
  onSave?: (payload: { playbackRate: number }) => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

const speedSliderChrome = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;

const SpeedBottomToolbar: React.FC<SpeedBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  fullscreenTargetRef,
  audioOnly = false,
  onClose,
  onSave,
}) => {
  const [playbackRate, setPlaybackRate] = useState(PLAYBACK_SPEED_DEFAULT);

  useEffect(() => {
    if (!active) return;
    setPlaybackRate(PLAYBACK_SPEED_DEFAULT);
  }, [active, mediaSrc]);

  const adjustedDuration = useMemo(() => {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return duration / playbackRate;
  }, [duration, playbackRate]);

  const adjustedDurationLabel = useMemo(() => {
    const seconds = Math.max(0, Math.round(adjustedDuration));
    return `${seconds}s`;
  }, [adjustedDuration]);

  const canSave = Boolean(mediaSrc);

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div className='flex flex-col items-center gap-1'>
        <PlaybackPanel
          videoRef={videoRef}
          mediaSrc={mediaSrc}
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          volume={volume}
          fullscreenTargetRef={fullscreenTargetRef}
          playbackRate={playbackRate}
          onPlaybackRateChange={setPlaybackRate}
          audioOnly={audioOnly}
          hideFilmstripAndWaveform={!audioOnly}
        />
        <div
          className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='nodrag nopan inline-flex h-8 items-center gap-1'>
            <Icon name='videoNode-speed' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Speed</span>
          </div>
          <div className='mx-2 inline-flex h-7 items-center justify-center rounded-[4px] border border-[#DBDBDB] px-2 text-[13px] font-medium text-text-default-secondary'>
            {formatPlaybackSpeed(playbackRate)}
          </div>
          <div className='flex h-7 w-[140px] items-center px-1'>
            <Slider
              className='nodrag !m-0 !w-full'
              min={PLAYBACK_SPEED_MIN}
              max={PLAYBACK_SPEED_MAX}
              step={PLAYBACK_SPEED_STEP}
              value={playbackRate}
              onChange={(value) => setPlaybackRate(roundPlaybackSpeedToStep(value))}
              {...speedSliderChrome}
            />
          </div>
          <div className='mx-1 inline-flex h-7 min-w-[48px] items-center justify-center rounded-[4px] border border-[#DBDBDB] px-2 text-[13px] font-medium text-text-default-secondary tabular-nums'>
            {adjustedDurationLabel}
          </div>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D] disabled:!cursor-not-allowed disabled:!border-[#D9D9D9] disabled:!bg-[#F0F0F0] disabled:!text-[#B5B5B5]'
            onClick={() => onSave?.({ playbackRate })}
            disabled={!canSave}
          >
            <Icon
              name='imageEditor-mark-save-icon'
              width={18}
              height={18}
              color={canSave ? '#FFFFFF' : '#B5B5B5'}
            />
            <span className='pl-2'>Save</span>
          </Button>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button
            type='button'
            className={iconBtnClass}
            aria-label='Close speed mode'
            onClick={onClose}
          >
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(SpeedBottomToolbar);
