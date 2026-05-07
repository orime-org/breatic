/**
 * Audio node top toolbar — image-node-style actions only (Replace + mini-tools). Upstream strip lives in {@link GenerationBottomToolbar}.
 */
import React from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Divider from '@/components/base/divider';

const moreMenuItemLabelClass = 'text-[13px] text-text-default-base';
const iconColor = 'var(--color-icon-base)';

export type AudioToolbarProps = {
  nodeId: string;
  onReplace: (nodeId: string, file: File) => void;
  onStemSplit: (nodeId: string) => void;
  onExtend: (nodeId: string) => void;
  onNormalize: (nodeId: string) => void;
  onDenoise: (nodeId: string) => void;
  onEnhance: (nodeId: string) => void;
  onSpeed: (nodeId: string) => void;
  onFadeInOut: (nodeId: string) => void;
  onSplit: (nodeId: string) => void;
  onTranscription: (nodeId: string) => void;
  onCompression: (nodeId: string) => void;
  onEq: (nodeId: string) => void;
  onPan: (nodeId: string) => void;
  onReverb: (nodeId: string) => void;
  onVoiceEnhancement: (nodeId: string) => void;
  onPitchShift: (nodeId: string) => void;
};

const primaryItems = [
  { key: 'stem', label: 'Stem', icon: 'videoNode-cut', w: 20, h: 20 },
  { key: 'extend', label: 'Extend', icon: 'videoNode-extend', w: 20, h: 20 },
  { key: 'normalize', label: 'Normalize', icon: 'videoNode-adjust', w: 20, h: 20 },
  { key: 'denoise', label: 'Denoise', icon: 'videoNode-audio-denoise', w: 16, h: 16 },
  { key: 'enhance', label: 'Enhance', icon: 'project-excalidraw-top-enhance-icon', w: 18, h: 15 },
  { key: 'speed', label: 'Speed', icon: 'videoNode-speed', w: 22, h: 18 },
] as const;

const Toolbar: React.FC<AudioToolbarProps> = ({
  nodeId,
  onReplace,
  onStemSplit,
  onExtend,
  onNormalize,
  onDenoise,
  onEnhance,
  onSpeed,
  onFadeInOut,
  onSplit,
  onTranscription,
  onCompression,
  onEq,
  onPan,
  onReverb,
  onVoiceEnhancement,
  onPitchShift,
}) => {
  const replaceInputRef = React.useRef<HTMLInputElement>(null);

  const moreItems: MenuItemType[] = [
    {
      key: 'fade',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-cut' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Fade In / Out</span>
        </div>
      ),
    },
    {
      key: 'split',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-crop' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Split / Trim</span>
        </div>
      ),
    },
    {
      key: 'transcription',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-chat-text-doc-icon' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Transcription (ASR)</span>
        </div>
      ),
    },
    {
      key: 'compression',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-adjust' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Compression</span>
        </div>
      ),
    },
    {
      key: 'eq',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-adjust' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>EQ</span>
        </div>
      ),
    },
    {
      key: 'pan',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-speed' width={16} height={14} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Pan</span>
        </div>
      ),
    },
    {
      key: 'reverb',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-animate' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Reverb</span>
        </div>
      ),
    },
    {
      key: 'voice-enhancement',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-excalidraw-top-enhance-icon' width={16} height={14} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Voice Enhancement</span>
        </div>
      ),
    },
    {
      key: 'pitch-shift',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='videoNode-interpolate' width={16} height={16} color={iconColor} />
          <span className={moreMenuItemLabelClass}>Pitch Shift</span>
        </div>
      ),
    },
  ];

  const dispatchPrimary = (key: string) => {
    switch (key) {
      case 'stem':
        onStemSplit(nodeId);
        return;
      case 'extend':
        onExtend(nodeId);
        return;
      case 'normalize':
        onNormalize(nodeId);
        return;
      case 'denoise':
        onDenoise(nodeId);
        return;
      case 'enhance':
        onEnhance(nodeId);
        return;
      case 'speed':
        onSpeed(nodeId);
        return;
      default:
    }
  };

  return (
    <div
      className='flex items-center gap-0 rounded-[8px] border border-border-default-base bg-background-default-base px-[6px] py-[4px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]'
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={replaceInputRef}
        type='file'
        accept='.mp3,.ogg,.wav,.webm'
        className='hidden'
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onReplace(nodeId, file);
        }}
      />
      <Tooltip title='Replace audio' placement='top' offset={4}>
        <button
          type='button'
          className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
          onClick={() => replaceInputRef.current?.click()}
        >
          <Icon name='project-upload-icon' width={16} height={16} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>Replace</span>
        </button>
      </Tooltip>
      <Divider type='vertical' className='mx-[2px] h-[18px]' />
      {primaryItems.map((item) => (
        <Tooltip key={item.key} title={item.label} placement='top' offset={4}>
          <button
            type='button'
            className='flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
            onClick={() => dispatchPrimary(item.key)}
          >
            <Icon name={item.icon} width={item.w} height={item.h} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>{item.label}</span>
          </button>
        </Tooltip>
      ))}
      <Divider type='vertical' className='mx-[2px] h-[18px]' />
      <Dropdown
        trigger='click'
        placement='bottom-end'
        offset={6}
        items={moreItems}
        onClick={(key) => {
          if (key === 'fade') onFadeInOut(nodeId);
          if (key === 'split') onSplit(nodeId);
          if (key === 'transcription') onTranscription(nodeId);
          if (key === 'compression') onCompression(nodeId);
          if (key === 'eq') onEq(nodeId);
          if (key === 'pan') onPan(nodeId);
          if (key === 'reverb') onReverb(nodeId);
          if (key === 'voice-enhancement') onVoiceEnhancement(nodeId);
          if (key === 'pitch-shift') onPitchShift(nodeId);
        }}
        popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
        itemClassName='min-h-8 px-2 py-1.5'
      >
        <Tooltip title='More' placement='top' offset={4}>
          <button
            type='button'
            className='flex h-8 w-8 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
          >
            <Icon name='project-excalidraw-top-more-icon' width={4} height={16} color='var(--color-icon-base)' />
          </button>
        </Tooltip>
      </Dropdown>
    </div>
  );
};

export default Toolbar;
