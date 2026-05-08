/**
 * Loudness normalize UX for local audio nodes — mirrors {@link AudioDenoiseBottomToolbar} chrome.
 */
import React, { memo, useState } from 'react';
import type { VideoRef } from '@/new/project/components/canvas/common/CanvasVideo';
import Slider from '@/components/base/slider';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import PlaybackPanel from '../videoNode/playback/PlaybackPanel';

export type AudioNormalizeBottomToolbarProps = {
  active: boolean;
  videoRef?: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  volume?: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  amount?: number;
  onChange?: (value: number) => void;
  onClose: () => void;
  onSend?: (payload: { amount: number }) => void;
};

const AMOUNT_MIN = 0;
const AMOUNT_MAX = 100;
const AMOUNT_STEP = 1;
const NORMALIZE_CREDIT = 120;
const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const sliderChrome = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;

const AudioNormalizeBottomToolbar: React.FC<AudioNormalizeBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime = 0,
  duration = 0,
  isPlaying = false,
  volume = 1,
  fullscreenTargetRef,
  amount = 70,
  onChange,
  onClose,
  onSend,
}) => {
  const [localValue, setLocalValue] = useState(amount);
  const value = onChange ? amount : localValue;
  const update = (next: number) => {
    const safe = Math.max(AMOUNT_MIN, Math.min(AMOUNT_MAX, Math.round(next)));
    if (onChange) onChange(safe);
    else setLocalValue(safe);
  };
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
          className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='nodrag nopan inline-flex h-8 items-center gap-1'>
            <Icon name='videoNode-adjust' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Normalize</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <span className='whitespace-nowrap text-[13px] font-medium leading-none text-text-default-secondary'>Strength</span>
          <div className='flex h-7 w-[130px] items-center px-1'>
            <Slider className='nodrag !m-0 !w-full' min={AMOUNT_MIN} max={AMOUNT_MAX} step={AMOUNT_STEP} value={value} onChange={update} {...sliderChrome} />
          </div>
          <div className='mx-1 inline-flex h-7 min-w-[52px] items-center justify-center rounded-[4px] border border-[#DBDBDB] px-2 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            {value}%
          </div>
          <div className='nodrag nopan flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>{NORMALIZE_CREDIT}</span>
          </div>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !ml-1 !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={() => onSend?.({ amount: value })}
          />
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close normalize toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(AudioNormalizeBottomToolbar);
