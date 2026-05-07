import React, { memo, useEffect, useState } from 'react';
import type { VideoRef } from '@/spaces/canvas/common/Video';
import { Button } from '@/ui/button';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import { Icon } from '@/ui/icon';
import Tooltip from '@/ui/tooltip';
import Divider from '@/ui/divider';
import { cn } from '@/utils/classnames';
import PlaybackPanel from '../playback/PlaybackPanel';

export type VideoAnimateStyleKey =
  | 'anime'
  | 'ghibli'
  | '3d-cartoon'
  | 'claymation'
  | 'watercolor'
  | 'teal-orange'
  | 'noir'
  | 'vhs'
  | 'neon-noir'
  | 'vintage';

export type AnimateBottomToolbarProps = {
  active: boolean;
  videoRef?: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  volume?: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSend?: (payload: { style: VideoAnimateStyleKey; prompt: string }) => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const animateLabelClass = 'nodrag nopan inline-flex h-8 shrink-0 items-center gap-1';
const ANIMATE_CREDIT = 120;
const animatePreviewTestImageSrc = '/video-node-animate-style-test.png';
const styleOptions: Array<{ key: VideoAnimateStyleKey; label: string; subtitle: string; imageSrc: string }> = [
  { key: 'anime', label: 'Anime', subtitle: 'Japanese animation', imageSrc: animatePreviewTestImageSrc },
  { key: 'ghibli', label: 'Ghibli', subtitle: 'Miyazaki Hayao hand-drawn', imageSrc: animatePreviewTestImageSrc },
  { key: '3d-cartoon', label: '3D Cartoon', subtitle: 'Pixar/Disney style', imageSrc: animatePreviewTestImageSrc },
  { key: 'claymation', label: 'Claymation', subtitle: 'Clay animation texture', imageSrc: animatePreviewTestImageSrc },
  { key: 'watercolor', label: 'Watercolor', subtitle: 'Common art style', imageSrc: animatePreviewTestImageSrc },
  { key: 'teal-orange', label: 'Teal & Orange', subtitle: 'Hollywood tone', imageSrc: animatePreviewTestImageSrc },
  { key: 'noir', label: 'Noir', subtitle: 'High contrast black/white', imageSrc: animatePreviewTestImageSrc },
  { key: 'vhs', label: 'VHS', subtitle: 'Retro lo-fi distortion', imageSrc: animatePreviewTestImageSrc },
  { key: 'neon-noir', label: 'Neon Noir', subtitle: 'Cyberpunk night', imageSrc: animatePreviewTestImageSrc },
  { key: 'vintage', label: 'Vintage', subtitle: 'Faded old photos', imageSrc: animatePreviewTestImageSrc },
];
const styleLabelMap = styleOptions.reduce(
  (acc, item) => {
    acc[item.key] = item.label;
    return acc;
  },
  {} as Record<VideoAnimateStyleKey, string>,
);
const styleSubtitleMap = styleOptions.reduce(
  (acc, item) => {
    acc[item.key] = item.subtitle;
    return acc;
  },
  {} as Record<VideoAnimateStyleKey, string>,
);
const styleMenuItems: MenuItemType[] = styleOptions.map((item) => ({
  key: item.key,
  label: (
    <div className='flex min-w-[220px] items-center gap-2 py-0.5'>
      <img src={item.imageSrc} alt='' className='h-6 w-6 shrink-0 rounded-[4px] object-cover' />
      <span className='flex min-w-0 max-w-[165px] flex-col leading-none'>
        <span className='truncate text-[13px] font-semibold text-text-default-base'>{item.label}</span>
        <span className='mt-1 truncate text-[11px] text-text-default-tertiary'>{item.subtitle}</span>
      </span>
    </div>
  ),
}));

const AnimateBottomToolbar: React.FC<AnimateBottomToolbarProps> = ({
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
  const [style, setStyle] = useState<VideoAnimateStyleKey>('anime');
  const [styleOpen, setStyleOpen] = useState(false);
  const selectedStyle = styleOptions.find((item) => item.key === style) ?? styleOptions[0];

  useEffect(() => {
    if (!active) return;
    setStyle('anime');
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
          className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className={animateLabelClass}>
            <Icon name='videoNode-animate' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Animate</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Dropdown
            trigger='click'
            placement='top-start'
            offset={8}
            items={styleMenuItems}
            selectedKeys={[style]}
            open={styleOpen}
            onOpenChange={setStyleOpen}
            onClick={(key) => setStyle(key as VideoAnimateStyleKey)}
            popupClassName='rounded-[8px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
            itemClassName='min-h-10 rounded-[6px] px-2'
          >
            <button type='button' className='nodrag nopan inline-flex h-8 min-w-[210px] items-center gap-2 rounded-[4px] px-[6px] hover:bg-background-default-base-hover' aria-label='Animate style'>
              <img src={selectedStyle.imageSrc} alt='' className='h-6 w-6 shrink-0 rounded-[6px] object-cover' />
              <span className='flex min-w-0 max-w-[145px] flex-1 flex-col text-left leading-none'>
                <span className='truncate text-[13px] font-semibold text-text-default-base'>{styleLabelMap[style]}</span>
                <span className='truncate text-[11px] text-text-default-tertiary'>{styleSubtitleMap[style]}</span>
              </span>
              <span className={cn('ml-auto flex shrink-0 items-center justify-center transition-transform duration-200', styleOpen ? 'rotate-180' : '')}>
                <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
              </span>
            </button>
          </Dropdown>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <div className='nodrag nopan flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>{ANIMATE_CREDIT}</span>
          </div>
          <Tooltip title='Run Animate' placement='top' offset={4}>
            <Button
              type='primary'
              shape='round'
              className='nodrag nopan !ml-1 !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
              onClick={() => onSend?.({ style, prompt: styleLabelMap[style] })}
              aria-label='Send animate'
            />
          </Tooltip>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close animate toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(AnimateBottomToolbar);
