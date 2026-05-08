/**
 * Fade in / fade out durations — local canvas chrome aligned with other audio mini-tools.
 */
import React, { memo, useEffect, useState } from 'react';
import type { VideoRef } from '@/new/project/components/canvas/common/CanvasVideo';
import Slider from '@/components/base/slider';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import PlaybackPanel from '../videoNode/playback/PlaybackPanel';

export type AudioFadeBottomToolbarProps = {
  active: boolean;
  videoRef?: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  volume?: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSend?: (payload: { fadeInSec: number; fadeOutSec: number }) => void;
};

const MAX_SEC = 5;
const STEP = 0.1;
const FADE_CREDIT = 120;
const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const sliderChrome = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;

const formatSec = (v: number) => `${v.toFixed(1)}s`;

const AudioFadeBottomToolbar: React.FC<AudioFadeBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime = 0,
  duration = 0,
  isPlaying = false,
  volume = 1,
  fullscreenTargetRef,
  onClose,
  onSend,
}) => {
  const [fadeInSec, setFadeInSec] = useState(0.5);
  const [fadeOutSec, setFadeOutSec] = useState(0.5);

  useEffect(() => {
    if (!active) return;
    setFadeInSec(0.5);
    setFadeOutSec(0.5);
  }, [active]);

  if (!active) return null;
  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div className='flex flex-col items-center gap-1'>
        <PlaybackPanel
          videoRef={videoRef ?? { current: null }}
          mediaSrc={mediaSrc}
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          volume={volume}
          fullscreenTargetRef={fullscreenTargetRef}
          audioOnly
        />
        <div
          className='nodrag nopan pointer-events-auto flex min-h-[40px] flex-wrap items-center gap-x-2 gap-y-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[6px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='nodrag nopan inline-flex h-8 items-center gap-1'>
            <Icon name='videoNode-cut' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Fade In / Out</span>
          </div>
          <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
          <span className='whitespace-nowrap text-[12px] font-medium text-text-default-secondary'>In</span>
          <div className='flex h-7 w-[100px] items-center px-1'>
            <Slider
              className='nodrag !m-0 !w-full'
              min={0}
              max={MAX_SEC}
              step={STEP}
              value={fadeInSec}
              onChange={setFadeInSec}
              {...sliderChrome}
            />
          </div>
          <span className='inline-flex min-w-[36px] justify-center text-[12px] font-medium tabular-nums text-text-default-secondary'>{formatSec(fadeInSec)}</span>
          <span className='whitespace-nowrap text-[12px] font-medium text-text-default-secondary'>Out</span>
          <div className='flex h-7 w-[100px] items-center px-1'>
            <Slider
              className='nodrag !m-0 !w-full'
              min={0}
              max={MAX_SEC}
              step={STEP}
              value={fadeOutSec}
              onChange={setFadeOutSec}
              {...sliderChrome}
            />
          </div>
          <span className='inline-flex min-w-[36px] justify-center text-[12px] font-medium tabular-nums text-text-default-secondary'>{formatSec(fadeOutSec)}</span>
          <div className='nodrag nopan ml-auto flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>{FADE_CREDIT}</span>
          </div>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={() => onSend?.({ fadeInSec, fadeOutSec })}
          />
          <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
          <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close fade toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(AudioFadeBottomToolbar);
