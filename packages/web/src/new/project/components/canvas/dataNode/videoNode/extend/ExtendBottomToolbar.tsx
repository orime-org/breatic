import React, { memo, useEffect, useRef, useState } from 'react';
import type { VideoRef } from '@/new/project/components/canvas/common/CanvasVideo';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import { cn } from '@/utils/classnames';
import PlaybackPanel from '../playback/PlaybackPanel';

export type VideoExtendDurationSec = 5 | 10 | 15;

export type ExtendBottomToolbarProps = {
  active: boolean;
  videoRef?: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  volume?: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSend?: (payload: { durationSec: VideoExtendDurationSec; prompt: string }) => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const durationLabelMap: Record<VideoExtendDurationSec, string> = { 5: '5s', 10: '10s', 15: '15s' };
const durationMenuItems: MenuItemType[] = ([15, 10, 5] as VideoExtendDurationSec[]).map((value) => ({
  key: String(value),
  label: <span className='text-[13px] font-semibold text-text-default-base'>{durationLabelMap[value]}</span>,
}));

const ExtendBottomToolbar: React.FC<ExtendBottomToolbarProps> = ({
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
  const [durationSec, setDurationSec] = useState<VideoExtendDurationSec>(5);
  const [durationOpen, setDurationOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const canSend = prompt.trim().length > 0;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!active) return;
    setDurationSec(5);
    setPrompt('');
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
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
          hideFilmstripAndWaveform
        />
        <div
          className='w-[430px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='flex items-center justify-between gap-1 px-1 pb-1'>
            <div className='inline-flex items-center gap-1'>
              <Icon name='videoNode-extend' width={20} height={20} color='var(--color-icon-base)' />
              <span className='text-sm font-bold text-text-default-base'>Extend</span>
            </div>
            <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close extend toolbar'>
              <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} />
            </button>
          </div>

          <div className='flex'>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='Describe the details to preserve or recover'
              className='h-[96px] w-full resize-none rounded-[8px] border border-border-default-base bg-transparent px-2 py-1.5 text-[13px] text-text-default-base outline-none placeholder:text-text-default-tertiary'
            />
          </div>

          <div className='mt-2 flex items-center justify-between gap-3 px-1'>
            <Dropdown
              trigger='click'
              placement='top-start'
              offset={8}
              items={durationMenuItems}
              selectedKeys={[String(durationSec)]}
              open={durationOpen}
              onOpenChange={setDurationOpen}
              onClick={(key) => setDurationSec(Number(key) as VideoExtendDurationSec)}
              popupClassName='rounded-[6px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
              itemClassName='h-8 px-2'
            >
              <button type='button' className='px-1 nodrag nopan inline-flex h-[28px] items-center rounded-[6px] bg-background-default-base hover:bg-background-default-base-hover' aria-label='Extend duration'>
                <span className='pr-2 text-[13px] font-semibold text-text-default-base'>{durationLabelMap[durationSec]}</span>
                <span className={cn('ml-auto flex shrink-0 items-center justify-center transition-transform duration-200', durationOpen ? 'rotate-180' : '')}>
                  <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
                </span>
              </button>
            </Dropdown>

            <div className='flex items-center gap-1'>
              <div className='inline-flex items-center gap-1 text-[12px] font-semibold text-text-default-tertiary'>
                <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
                <span>120</span>
              </div>
              <Tooltip title='Run Extend' placement='top' offset={4}>
                <Button
                  type='primary'
                  size='medium'
                  shape='round'
                  className='!h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#2FB344] !border-[#2FB344] hover:!bg-[#28A13D] hover:!border-[#28A13D] disabled:!bg-[#D8D8D8] disabled:!border-[#D8D8D8]'
                  icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
                  onClick={() => onSend?.({ durationSec, prompt })}
                  disabled={!canSend}
                  aria-label='Send extend'
                />
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(ExtendBottomToolbar);
