import React, { memo, useMemo, useState } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import Slider from '@/components/base/slider';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Switch from '@/components/base/switch';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import type { HdrOutputPreset } from '@/utils/videoHdrConversionWithFfmpeg';
import PlaybackPanel from '../playback/PlaybackPanel';

export type HdrConversionPayload = {
  preset: HdrOutputPreset;
  intensity: number;
  aiEnhance: boolean;
};

export type HdrConversionBottomToolbarProps = {
  active: boolean;
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  processing?: boolean;
  progressPct?: number;
  aiCredit?: number;
  onClose: () => void;
  onSave?: (payload: HdrConversionPayload) => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const sliderChrome = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;

const presetOptions: Array<{ key: HdrOutputPreset; label: string; subtitle: string }> = [
  { key: 'hdr10', label: 'HDR10', subtitle: '10-bit  ·  1000 nit' },
  { key: 'hlg', label: 'HLG', subtitle: 'Broadcast  ·  HLG' },
  { key: 'dolby-vision', label: 'Dolby Vision', subtitle: 'Perceptual  ·  12-bit' },
];

const HdrConversionBottomToolbar: React.FC<HdrConversionBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  fullscreenTargetRef,
  processing = false,
  progressPct: _progressPct = 0,
  aiCredit = 120,
  onClose,
  onSave,
}) => {
  const [preset, setPreset] = useState<HdrOutputPreset>('hdr10');
  const [presetOpen, setPresetOpen] = useState(false);
  const [aiEnhance, setAiEnhance] = useState(false);
  const [intensity, setIntensity] = useState(50);
  const canSave = Boolean(mediaSrc) && !processing;

  const presetMenuItems: MenuItemType[] = useMemo(
    () =>
      presetOptions.map((item) => ({
        key: item.key,
        label: (
          <span className='inline-flex min-w-[188px] flex-col leading-none'>
            <span className='text-[13px] font-bold text-text-default-base'>{item.label}</span>
            <span className='mt-1 text-[12px] text-text-default-secondary'>{item.subtitle}</span>
          </span>
        ),
      })),
    [],
  );
  const selectedPreset = presetOptions.find((item) => item.key === preset) ?? presetOptions[0];

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
          hideFilmstripAndWaveform
        />
        <div
          className='nodrag nopan pointer-events-auto flex min-h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='nodrag nopan inline-flex h-8 items-center gap-1'>
            <Icon name='videoNode-hdr-conversion' width={18} height={16} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>HDR Conversion</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Dropdown
            trigger='click'
            placement='top-start'
            offset={8}
            items={presetMenuItems}
            selectedKeys={[preset]}
            open={presetOpen}
            onOpenChange={setPresetOpen}
            onClick={(key) => setPreset(key as HdrOutputPreset)}
            popupClassName='rounded-[8px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
            itemClassName='min-h-[52px] rounded-[6px] px-2 py-1'
          >
            <button
              type='button'
              className='nodrag nopan inline-flex h-7 min-w-[86px] items-center justify-between gap-2 rounded-[4px] border border-[#DBDBDB] px-2 hover:bg-background-default-base-hover'
              aria-label='HDR preset'
              disabled={processing}
            >
              <span className='text-[13px] font-semibold text-text-default-base'>{selectedPreset.label}</span>
              <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
            </button>
          </Dropdown>
          <div className='mx-2 inline-flex h-7 items-center gap-2 px-1'>
            <span className='text-[13px] font-medium text-text-default-base'>AI Enhance</span>
            <Switch
              checked={aiEnhance}
              onChange={setAiEnhance}
              disabled={processing}
            />
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <span className='text-[13px] font-medium text-text-default-secondary'>Intensity</span>
          <div className='flex h-7 w-[130px] items-center px-1'>
            <Slider
              className='nodrag !m-0 !w-full'
              min={0}
              max={100}
              step={1}
              value={intensity}
              onChange={(value) => setIntensity(Math.max(0, Math.min(100, Math.round(value))))}
              {...sliderChrome}
            />
          </div>
          <div className='mx-1 inline-flex h-7 w-[48px] items-center justify-center rounded-[4px] border border-[#DBDBDB] px-2 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            {intensity}%
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          {aiEnhance ? (
            <div className='nodrag nopan flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
              <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
              <span>{aiCredit}</span>
            </div>
          ) : null}
          {aiEnhance ? (
            <Button
              type='primary'
              shape='round'
              className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D] disabled:!cursor-not-allowed disabled:!border-[#D9D9D9] disabled:!bg-[#F0F0F0] disabled:!text-[#B5B5B5]'
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color={canSave ? '#FFFFFF' : '#B5B5B5'} />}
              onClick={() => onSave?.({ preset, intensity, aiEnhance })}
              disabled={!canSave}
              aria-label='Run HDR AI Enhance'
            />
          ) : (
            <Button
              type='primary'
              shape='round'
              className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D] disabled:!cursor-not-allowed disabled:!border-[#D9D9D9] disabled:!bg-[#F0F0F0] disabled:!text-[#B5B5B5]'
              onClick={() => onSave?.({ preset, intensity, aiEnhance })}
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
          )}
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button
            type='button'
            className={iconBtnClass}
            aria-label='Close HDR conversion mode'
            onClick={() => {
              if (processing) return;
              onClose();
            }}
          >
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(HdrConversionBottomToolbar);
