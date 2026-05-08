/**
 * Audio enhancement presets for local canvas nodes — mirrors video Upscale dropdown + send chrome.
 */
import React, { memo, useEffect, useState } from 'react';
import type { VideoRef } from '@/new/project/components/canvas/common/CanvasVideo';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import PlaybackPanel from '../videoNode/playback/PlaybackPanel';

export type AudioEnhancePreset = 'speech' | 'music' | 'broadcast' | 'restore';

export type AudioEnhanceBottomToolbarProps = {
  active: boolean;
  videoRef?: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  volume?: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSend?: (payload: { preset: AudioEnhancePreset }) => void;
};

const ENHANCE_CREDIT = 120;
const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

const presetOptions: Array<{ key: AudioEnhancePreset; label: string }> = [
  { key: 'speech', label: 'Enhance speech clarity' },
  { key: 'music', label: 'Enhance music detail' },
  { key: 'broadcast', label: 'Broadcast-ready loudness' },
  { key: 'restore', label: 'Restore lost detail' },
];

const enhanceMenuItems: MenuItemType[] = presetOptions.map((opt) => ({
  key: opt.key,
  label: (
    <div className='flex w-full min-w-[220px] items-center justify-between gap-3'>
      <span className='min-w-0 flex-1 truncate text-left text-[13px] font-medium text-text-default-base'>{opt.label}</span>
      <div className='flex shrink-0 items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-base'>
        <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
        <span>{ENHANCE_CREDIT}</span>
      </div>
    </div>
  ),
}));

const AudioEnhanceBottomToolbar: React.FC<AudioEnhanceBottomToolbarProps> = ({
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
  const [preset, setPreset] = useState<AudioEnhancePreset>('speech');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!active) return;
    setPreset('speech');
  }, [active]);

  const label = presetOptions.find((o) => o.key === preset)?.label ?? presetOptions[0].label;

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
            <Icon name='project-excalidraw-top-enhance-icon' width={18} height={15} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Enhance</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Dropdown
            trigger='click'
            placement='top-start'
            offset={8}
            items={enhanceMenuItems}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onClick={(key) => {
              setPreset(key as AudioEnhancePreset);
              setMenuOpen(false);
            }}
            popupClassName='rounded-[8px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
            itemClassName='min-h-9 px-2 py-1.5'
          >
            <button
              type='button'
              className='nodrag nopan inline-flex h-[28px] max-w-[260px] items-center gap-1 rounded-[6px] px-2 hover:bg-background-default-base-hover'
              aria-haspopup='menu'
              aria-expanded={menuOpen}
              aria-label='Enhancement preset'
            >
              <span className='min-w-0 truncate text-left text-[13px] font-medium text-text-default-base'>{label}</span>
              <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
            </button>
          </Dropdown>
          <div className='nodrag nopan ml-auto flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>{ENHANCE_CREDIT}</span>
          </div>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !ml-1 !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={() => onSend?.({ preset })}
          />
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close enhance toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(AudioEnhanceBottomToolbar);
