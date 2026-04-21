import React, { memo, useEffect, useState } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Divider from '@/components/base/divider';
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
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSend?: (payload: { style: VideoAnimateStyleKey; prompt: string }) => void;
};

const iconBtnClass =
  'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

/** Temporary local preview image provided by design review (replace with real per-style assets later). */
const animatePreviewTestImageSrc = '/video-node-animate-style-test.png';

const styleOptions: Array<{ key: VideoAnimateStyleKey; label: string; subtitle: string; imageSrc: string }> = [
  { key: 'anime', label: 'Anime', subtitle: 'Japanese animation', imageSrc: animatePreviewTestImageSrc },
  { key: 'ghibli', label: 'Ghibli', subtitle: 'Miyazaki Hayao\'s hand-drawn', imageSrc: animatePreviewTestImageSrc },
  { key: '3d-cartoon', label: '3D Cartoon', subtitle: 'Pixar/Disney style', imageSrc: animatePreviewTestImageSrc },
  { key: 'claymation', label: 'Claymation', subtitle: 'Clay animation texture', imageSrc: animatePreviewTestImageSrc },
  { key: 'watercolor', label: 'Watercolor', subtitle: 'The most common art style', imageSrc: animatePreviewTestImageSrc },
  { key: 'teal-orange', label: 'Teal & Orange', subtitle: 'Hollywood Standard Tone', imageSrc: animatePreviewTestImageSrc },
  { key: 'noir', label: 'Noir', subtitle: 'High contrast black and white', imageSrc: animatePreviewTestImageSrc },
  { key: 'vhs', label: 'VHS', subtitle: 'Videotape distortion, retro Lo-fi', imageSrc: animatePreviewTestImageSrc },
  { key: 'neon-noir', label: 'Neon Noir', subtitle: 'Cyberpunk Night View', imageSrc: animatePreviewTestImageSrc },
  { key: 'vintage', label: 'Vintage', subtitle: 'Faded old photos', imageSrc: animatePreviewTestImageSrc },
];

const styleLabelMap: Record<VideoAnimateStyleKey, string> = styleOptions.reduce(
  (acc, item) => {
    acc[item.key] = item.label;
    return acc;
  },
  {} as Record<VideoAnimateStyleKey, string>,
);

const styleSubtitleMap: Record<VideoAnimateStyleKey, string> = styleOptions.reduce(
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
      <img
        src={item.imageSrc}
        alt=''
        className='h-6 w-6 shrink-0 rounded-[4px] object-cover'
      />
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
  currentTime,
  duration,
  isPlaying,
  volume,
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
          videoRef={videoRef}
          mediaSrc={mediaSrc}
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          volume={volume}
          fullscreenTargetRef={fullscreenTargetRef}
        />
        <div
          className='flex w-[520px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[8px] py-[6px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base'>
            <Icon name='videoNode-animate' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>Animate</span>
          </div>
          <Divider type='vertical' className='mx-[2px] h-[18px] bg-[#D0D0D0]' />

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
            <button
              type='button'
              className='nodrag nopan inline-flex h-8 min-w-[210px] items-center gap-2 rounded-[4px] px-[6px] hover:bg-background-default-base-hover'
              aria-label='Animate style'
            >
              <img
                src={selectedStyle.imageSrc}
                alt=''
                className='h-6 w-6 shrink-0 rounded-[6px] object-cover'
              />
              <span className='flex min-w-0 max-w-[145px] flex-1 flex-col text-left leading-none'>
                <span className='truncate text-[13px] font-semibold text-text-default-base'>{styleLabelMap[style]}</span>
                <span className='truncate text-[11px] text-text-default-tertiary'>{styleSubtitleMap[style]}</span>
              </span>
              <span
                className={cn(
                  'ml-auto flex shrink-0 items-center justify-center transition-transform duration-200',
                  styleOpen ? 'rotate-180' : '',
                )}
              >
                <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
              </span>
            </button>
          </Dropdown>
          <Divider type='vertical' className='mx-[2px] h-[18px] bg-[#D0D0D0]' />
          <div className='ml-auto flex items-center gap-1'>
            <div className='inline-flex items-center gap-1 text-[12px] font-semibold text-text-default-tertiary'>
              <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
              <span>120</span>
            </div>
            <Tooltip title='Run Animate' placement='top' offset={4}>
              <Button
                type='primary'
                size='medium'
                shape='round'
                className='!h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#2FB344] !border-[#2FB344] hover:!bg-[#28A13D] hover:!border-[#28A13D]'
                icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
                onClick={() => onSend?.({ style, prompt: styleLabelMap[style] })}
                aria-label='Send animate'
              />
            </Tooltip>
            <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
            <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close animate toolbar'>
              <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(AnimateBottomToolbar);
