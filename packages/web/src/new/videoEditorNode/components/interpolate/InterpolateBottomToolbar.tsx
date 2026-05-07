import React, { memo, useState } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import { Button } from '@/ui/button';
import { Icon } from '@/ui/icon';
import Divider from '@/ui/divider';
import Tooltip from '@/ui/tooltip';
import PlaybackPanel from '../playback/PlaybackPanel';

type InterpolateBottomToolbarProps = {
  active: boolean;
  onClose: () => void;
  onSend?: () => void;
  videoRef?: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  volume?: number;
};

type InterpolateTargetFps = '30fps' | '50fps' | '60fps' | '120fps' | '240fps';
const INTERPOLATE_CREDIT = 120;
const interpolateOptions: Array<{ key: InterpolateTargetFps; label: string }> = [
  { key: '30fps', label: 'Enhance to 30FPS' },
  { key: '50fps', label: 'Enhance to 50FPS' },
  { key: '60fps', label: 'Enhance to 60FPS' },
  { key: '120fps', label: 'Enhance to 120FPS' },
  { key: '240fps', label: 'Enhance to 240FPS' },
];
const interpolateMenuItems: MenuItemType[] = interpolateOptions.map((opt) => ({
  key: opt.key,
  label: (
    <div className='flex w-full min-w-[220px] items-center justify-between gap-3'>
      <span className='min-w-0 flex-1 truncate text-left text-[13px] font-medium text-text-default-base'>{opt.label}</span>
      <div className='flex shrink-0 items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-base'>
        <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
        <span>{INTERPOLATE_CREDIT}</span>
      </div>
    </div>
  ),
}));
const interpolateLabelMap = interpolateOptions.reduce(
  (acc, item) => {
    acc[item.key] = item.label;
    return acc;
  },
  {} as Record<InterpolateTargetFps, string>,
);
const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

const InterpolateBottomToolbar: React.FC<InterpolateBottomToolbarProps> = ({
  active,
  onClose,
  onSend,
  videoRef,
  mediaSrc,
  currentTime = 0,
  duration = 0,
  isPlaying = false,
  volume = 1,
}) => {
  const [targetOpen, setTargetOpen] = useState(false);
  const [target, setTarget] = useState<InterpolateTargetFps>('60fps');
  if (!active) return null;
  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <PlaybackPanel
        videoRef={videoRef ?? { current: null }}
        mediaSrc={mediaSrc}
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        volume={volume}
        hideFilmstripAndWaveform
      />
      <div
        className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='nodrag nopan inline-flex h-8 shrink-0 items-center gap-1'>
          <Icon name='videoNode-interpolate' width={20} height={18} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Interpolate</span>
        </div>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Dropdown
          trigger='click'
          placement='top-start'
          offset={8}
          items={interpolateMenuItems}
          selectedKeys={[target]}
          open={targetOpen}
          onOpenChange={setTargetOpen}
          onClick={(key) => {
            setTarget(key as InterpolateTargetFps);
            setTargetOpen(false);
          }}
          popupClassName='rounded-[8px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
          itemClassName='min-h-9 px-2 py-1.5'
        >
          <button
            type='button'
            className='nodrag nopan inline-flex h-8 min-w-[190px] items-center gap-2 rounded-[4px] px-[6px] hover:bg-background-default-base-hover'
          >
            <span className='truncate text-[13px] font-semibold text-text-default-base'>{interpolateLabelMap[target]}</span>
            <span className={`ml-auto flex shrink-0 items-center justify-center transition-transform duration-200 ${targetOpen ? 'rotate-180' : ''}`}>
              <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
            </span>
          </button>
        </Dropdown>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <div className='nodrag nopan flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
          <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
          <span>{INTERPOLATE_CREDIT}</span>
        </div>
        <Tooltip title='Run Interpolate' placement='top' offset={4}>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !ml-1 !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={onSend}
            aria-label='Send interpolate'
          />
        </Tooltip>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <button type='button' onClick={onClose} className={iconBtnClass} aria-label='Close interpolate toolbar'>
          <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
        </button>
      </div>
    </div>
  );
};

export default memo(InterpolateBottomToolbar);
