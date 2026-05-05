import React, { useState } from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Divider from '@/components/base/divider';
export type VideoUpscaleTarget = '360p' | '480p' | '720p' | '1080p' | '4k';

export type VideoInterpolateTarget = '30' | '50' | '60' | '120' | '240';

export type ToolbarProps = {
  nodeId: string;
  onCut?: (nodeId: string) => void;
  onSpeed?: (nodeId: string) => void;
  onUpscale?: (nodeId: string, target: VideoUpscaleTarget) => void;
  onInterpolate?: (nodeId: string, target: VideoInterpolateTarget) => void;
  onErase?: (nodeId: string) => void;
  onExtend?: (nodeId: string) => void;
  onAnimate?: (nodeId: string) => void;
  onAdjust?: (nodeId: string) => void;
  onStabilization?: (nodeId: string) => void;
  onLipSync?: (nodeId: string) => void;
  onCrop?: (nodeId: string) => void;
  onHdrConversion?: (nodeId: string) => void;
  onCutout?: (nodeId: string) => void;
  onSceneExtension?: (nodeId: string) => void;
  onAudioDenoise?: (nodeId: string) => void;
};

const iconColor = 'var(--color-icon-base)';

const UPSCALE_CREDIT = 120;
const INTERPOLATE_CREDIT = 120;

const videoUpscaleOptions: Array<{
  key: VideoUpscaleTarget;
  label: string;
}> = [
  { key: '360p', label: 'Enhance to 360p' },
  { key: '480p', label: 'Enhance to 480p' },
  { key: '720p', label: 'Enhance to 720p' },
  { key: '1080p', label: 'Enhance to 1080p' },
  { key: '4k', label: 'Enhance to 4k' },
];

const upscaleMenuItems: MenuItemType[] = videoUpscaleOptions.map((opt) => ({
  key: opt.key,
  label: (
    <div className='flex w-full min-w-[200px] items-center justify-between gap-3'>
      <span className='min-w-0 flex-1 truncate text-left text-[13px] font-medium text-text-default-base'>{opt.label}</span>
      <div className='flex shrink-0 items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-base'>
        <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
        <span>{UPSCALE_CREDIT}</span>
      </div>
    </div>
  ),
}));

const videoInterpolateOptions: Array<{
  key: VideoInterpolateTarget;
  label: string;
}> = [
  { key: '30', label: 'Enhance to 30FPS' },
  { key: '50', label: 'Enhance to 50FPS' },
  { key: '60', label: 'Enhance to 60FPS' },
  { key: '120', label: 'Enhance to 120FPS' },
  { key: '240', label: 'Enhance to 240FPS' },
];

const interpolateMenuItems: MenuItemType[] = videoInterpolateOptions.map((opt) => ({
  key: opt.key,
  label: (
    <div className='flex w-full min-w-[200px] items-center justify-between gap-3'>
      <span className='min-w-0 flex-1 truncate text-left text-[13px] font-medium text-text-default-base'>{opt.label}</span>
      <div className='flex shrink-0 items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-base'>
        <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
        <span>{INTERPOLATE_CREDIT}</span>
      </div>
    </div>
  ),
}));

type IconToolbarItem = { key: string; label: string; icon: string; w: number; h: number };

const dividerClass = 'mx-[2px] h-[18px]';
const moreMenuItemLabelClass = 'text-[13px] text-text-default-base';

const Toolbar: React.FC<ToolbarProps> = ({
  nodeId,
  onCut,
  onSpeed,
  onUpscale,
  onInterpolate,
  onErase,
  onExtend,
  onAnimate,
  onAdjust,
  onStabilization,
  onLipSync,
  onCrop,
  onHdrConversion,
  onCutout,
  onSceneExtension,
  onAudioDenoise,
}) => {
  const [upscaleOpen, setUpscaleOpen] = useState(false);
  const [interpolateOpen, setInterpolateOpen] = useState(false);

  const mainActionsAfterQuickEdit: IconToolbarItem[] = [
    { key: 'cut', label: 'Cut', icon: 'videoNode-cut', w: 20, h: 21 },
    { key: 'speed', label: 'Speed', icon: 'videoNode-speed', w: 22, h: 18 },
    { key: 'upscale', label: 'Upscale', icon: 'videoNode-upscale-hd', w: 22, h: 18 },
    { key: 'interpolate', label: 'Interpolate', icon: 'videoNode-interpolate', w: 22, h: 22 },
    { key: 'erase', label: 'Erase', icon: 'videoNode-erase', w: 20, h: 20 },
    { key: 'extend', label: 'Extend', icon: 'videoNode-extend', w: 20, h: 20 },
  ];

  const moreItems: MenuItemType[] = [
    {
      key: 'animate',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-animate' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Animate</span>
        </div>
      ),
    },
    {
      key: 'adjust',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-adjust' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Adjust</span>
        </div>
      ),
    },
    {
      key: 'stabilization',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-stabilization' width={16} height={13} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Stabilization</span>
        </div>
      ),
    },
    {
      key: 'lip-sync',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-lip-sync' width={16} height={14} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Lip Sync</span>
        </div>
      ),
    },
    {
      key: 'crop',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-crop' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Crop</span>
        </div>
      ),
    },
    {
      key: 'hdr-conversion',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-hdr-conversion' width={16} height={14} color={iconColor} />
          <span className={moreMenuItemLabelClass}>HDR Conversion</span>
        </div>
      ),
    },
    {
      key: 'cutout',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-cutout' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Cutout</span>
        </div>
      ),
    },
    {
      key: 'scene-extension',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-scene-extension' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Scene Extension</span>
        </div>
      ),
    },
    {
      key: 'audio-denoise',
      label: (
        <div className='flex items-center gap-1 text-icon-base'>
          <Icon name='videoNode-audio-denoise' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Audio Denoise</span>
        </div>
      ),
    },
  ];

  return (
    <div
      className='pointer-events-auto flex items-center gap-0 rounded-[8px] border border-border-default-base bg-background-default-base px-[6px] py-[4px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]'
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Tooltip title='Quick Edit' placement='top' offset={4}>
        <button
          type='button'
          className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
        >
          <Icon name='project-excalidraw-top-quick-edit-icon' width={18} height={18} color={iconColor} />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>Quick Edit</span>
        </button>
      </Tooltip>
      <Divider type='vertical' className={dividerClass} />
      {mainActionsAfterQuickEdit.map((item) => {
        if (item.key === 'upscale') {
          return (
            <Dropdown
              key={item.key}
              trigger='click'
              placement='bottom-start'
              offset={6}
              items={upscaleMenuItems}
              open={upscaleOpen}
              onOpenChange={setUpscaleOpen}
              onClick={(key) => {
                onUpscale?.(nodeId, key as VideoUpscaleTarget);
                setUpscaleOpen(false);
              }}
              popupClassName='rounded-[8px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
              itemClassName='min-h-9 px-2 py-1.5'
            >
              <Tooltip title={item.label} placement='top' offset={4}>
                <button
                  type='button'
                  className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
                  aria-haspopup='menu'
                  aria-expanded={upscaleOpen}
                  aria-label='Upscale options'
                >
                  <Icon name={item.icon} width={item.w} height={item.h} color={iconColor} />
                  <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>{item.label}</span>
                </button>
              </Tooltip>
            </Dropdown>
          );
        }
        if (item.key === 'interpolate') {
          return (
            <Dropdown
              key={item.key}
              trigger='click'
              placement='bottom-start'
              offset={6}
              items={interpolateMenuItems}
              open={interpolateOpen}
              onOpenChange={setInterpolateOpen}
              onClick={(key) => {
                onInterpolate?.(nodeId, key as VideoInterpolateTarget);
                setInterpolateOpen(false);
              }}
              popupClassName='rounded-[8px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
              itemClassName='min-h-9 px-2 py-1.5'
            >
              <Tooltip title={item.label} placement='top' offset={4}>
                <button
                  type='button'
                  className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
                  aria-haspopup='menu'
                  aria-expanded={interpolateOpen}
                  aria-label='Interpolate options'
                >
                  <Icon name={item.icon} width={item.w} height={item.h} color={iconColor} />
                  <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>{item.label}</span>
                </button>
              </Tooltip>
            </Dropdown>
          );
        }
        return (
          <Tooltip key={item.key} title={item.label} placement='top' offset={4}>
            <button
              type='button'
              className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
              onClick={() => {
                if (item.key === 'cut') onCut?.(nodeId);
                if (item.key === 'speed') onSpeed?.(nodeId);
                if (item.key === 'erase') onErase?.(nodeId);
                if (item.key === 'extend') onExtend?.(nodeId);
              }}
            >
              <Icon name={item.icon} width={item.w} height={item.h} color={iconColor} />
              <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>{item.label}</span>
            </button>
          </Tooltip>
        );
      })}
      <Divider type='vertical' className={dividerClass} />
      <Dropdown
        trigger='click'
        placement='bottom-end'
        offset={6}
        items={moreItems}
        onClick={(key) => {
          if (key === 'animate') onAnimate?.(nodeId);
          if (key === 'adjust') onAdjust?.(nodeId);
          if (key === 'stabilization') onStabilization?.(nodeId);
          if (key === 'lip-sync') onLipSync?.(nodeId);
          if (key === 'crop') onCrop?.(nodeId);
          if (key === 'hdr-conversion') onHdrConversion?.(nodeId);
          if (key === 'cutout') onCutout?.(nodeId);
          if (key === 'scene-extension') onSceneExtension?.(nodeId);
          if (key === 'audio-denoise') onAudioDenoise?.(nodeId);
        }}
        popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
        itemClassName='min-h-8 px-2 py-1.5'
      >
        <Tooltip title='More' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-8 w-8 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
          >
            <Icon name='project-excalidraw-top-more-icon' width={4} height={16} color={iconColor} />
          </button>
        </Tooltip>
      </Dropdown>
    </div>
  );
};

export default Toolbar;
