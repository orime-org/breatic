import React, { useState } from 'react';
import { Icon } from '@/components/base/icon';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Slider from '@/components/base/slider';
import { Button } from '@/components/base/button';
import TextArea from '@/components/base/textArea';

export type VideoQuickActionPlacementType = 'stabilization' | 'audioDenoise';

/** Default width of the Text-to-Speech placeholder node (flow + preview). */
export const textToSpeechPlaceholderDefaultWidth = 635;
/** Compact width for the stabilization hint card. */
export const textToSpeechPlaceholderStabilizationWidth = 240;

export function textToSpeechPlaceholderWidthForAction(action: VideoQuickActionPlacementType): number {
  return action === 'stabilization' ? textToSpeechPlaceholderStabilizationWidth : textToSpeechPlaceholderDefaultWidth;
}
/**
 * Fixed height (px) for the TTS flow node, drag preview, and drop centering — same before/after add.
 * Keep in sync with the card’s real layout (padding + gaps + TextArea + controls).
 */
export const textToSpeechPlaceholderDefaultHeight = 275;
/** Compact card height for the stabilization placement preview / node box. */
export const textToSpeechPlaceholderStabilizationHeight = 64;

export function textToSpeechPlaceholderHeightForAction(action: VideoQuickActionPlacementType): number {
  return action === 'stabilization' ? textToSpeechPlaceholderStabilizationHeight : textToSpeechPlaceholderDefaultHeight;
}

/** Width + height for placement math, drag preview, and flow `style` (same box before/after add). */
export function textToSpeechPlaceholderSizeForAction(action: VideoQuickActionPlacementType): { width: number; height: number } {
  return {
    width: textToSpeechPlaceholderWidthForAction(action),
    height: textToSpeechPlaceholderHeightForAction(action),
  };
}

/** Flow `style` — same width/height as `textToSpeechPlaceholderSizeForAction`. */
export function textToSpeechPlaceholderNodeStyle(action: VideoQuickActionPlacementType): { width: number; height: number } {
  return textToSpeechPlaceholderSizeForAction(action);
}

export type TextToSpeechPlaceholderPanelProps = {
  action: VideoQuickActionPlacementType;
  /** Whether the node is selected (stroke highlight); same pattern as BlankPlaceholderPanel. */
  selected?: boolean;
};

const actionCopy: Record<VideoQuickActionPlacementType, { title: string; subtitle: string; icon: string }> = {
  stabilization: {
    title: 'Video Stabilization',
    subtitle: 'Click a video node to open',
    icon: 'project-video-right-stabilization-icon',
  },
  audioDenoise: {
    title: 'Text-to-Speech',
    subtitle: 'Click a video node to open',
    icon: 'project-video-right-audio-denoise-icon',
  },
};

const languageItems: MenuItemType[] = [
  { key: 'zh-CN', label: '中文-普通话' },
  { key: 'en-US', label: 'English-US' },
];
const voiceItems: MenuItemType[] = [
  { key: 'steady', label: '沉稳高管' },
  { key: 'warm', label: '温暖女声' },
];
const emotionItems: MenuItemType[] = [
  { key: 'happy', label: 'Happy' },
  { key: 'calm', label: 'Calm' },
];
const audioFxItems: MenuItemType[] = [
  { key: 'auditorium-echo', label: 'Auditorium Echo' },
  { key: 'studio-dry', label: 'Studio Dry' },
];

/**
 * Text-to-Speech / video quick-action placement preview and on-flow placeholder UI.
 */
export const TextToSpeechPlaceholderPanel: React.FC<TextToSpeechPlaceholderPanelProps> = ({ action, selected = false }) => {
  const [languageKey, setLanguageKey] = useState('zh-CN');
  const [voiceKey, setVoiceKey] = useState('steady');
  const [emotionKey, setEmotionKey] = useState('happy');
  const [audioFxKey, setAudioFxKey] = useState('auditorium-echo');
  const [speed, setSpeed] = useState(0.5);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [emotionOpen, setEmotionOpen] = useState(false);
  const [audioFxOpen, setAudioFxOpen] = useState(false);
  const [script, setScript] = useState('');

  const languageLabel = languageItems.find((item) => item.key === languageKey)?.label ?? '中文-普通话';
  const voiceLabel = voiceItems.find((item) => item.key === voiceKey)?.label ?? '沉稳高管';
  const emotionLabel = emotionItems.find((item) => item.key === emotionKey)?.label ?? 'Happy';
  const audioFxLabel = audioFxItems.find((item) => item.key === audioFxKey)?.label ?? 'Auditorium Echo';

  const borderColor = selected ? '#97A0FF' : '#D6D9E5';

  const selectorBtnClass = 'inline-flex h-8 w-full min-w-0 items-center justify-between gap-1 rounded-[4px] bg-background-default-secondary px-3 text-[12px] text-text-default-base hover:bg-background-default-base-hover';
  const selectorDropdownWrapClass = 'min-w-0 flex-1 [&>div]:block [&>div]:w-full';
  const dropdownPopupClass = 'rounded-[8px] border border-border-default-base p-0 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]';
  const dropdownItemClass = 'min-h-8 px-3 py-1 text-[13px]';

  if (action === 'stabilization') {
    const copy = actionCopy[action];
    return (
      <div
        className='flex h-full w-full min-h-0 flex-col overflow-hidden rounded-[16px] border bg-white/95 p-[12px] backdrop-blur-[1px]'
        style={{ borderColor }}
      >
        <div className='flex min-h-0 flex-1 items-center gap-2'>
          <div className='inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[#F3F4FF] text-icon-base'>
            <Icon name={copy.icon} width={18} height={18} />
          </div>
          <div className='min-w-0'>
            <div className='truncate text-[13px] font-semibold leading-4 text-text-default-base'>{copy.title}</div>
            <div className='truncate text-[11px] leading-4 text-text-default-secondary'>{copy.subtitle}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className='flex h-full w-full min-h-0 flex-col gap-[10px] overflow-x-hidden overflow-y-auto rounded-[16px] border bg-background-default-base p-[12px]'
      style={{ borderColor }}
    >
      <div className='flex shrink-0 items-center gap-1 text-text-default-base'>
        <Icon name='project-video-right-audio-denoise-icon' width={14} height={14} />
        <span className='text-[13px] font-semibold leading-none'>Text-to-Speech</span>
      </div>

      <TextArea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        placeholder='Enter your script...'
        type='outlined'
        size='small'
        className='nodrag nopan shrink-0 !h-[99px] !resize-none !rounded-[6px] !border-border-default-base !bg-background-default-secondary !px-2 !py-1.5 !text-[11px]'
      />

      <div className='grid shrink-0 grid-cols-3 gap-3 text-[12px] text-text-default-secondary'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='shrink-0 text-text-default-base'>Language</span>
          <div className={selectorDropdownWrapClass}>
            <Dropdown
              items={languageItems}
              trigger='click'
              open={languageOpen}
              onOpenChange={setLanguageOpen}
              onClick={(key) => setLanguageKey(String(key))}
              popupClassName={dropdownPopupClass}
              itemClassName={dropdownItemClass}
            >
              <button type='button' className={selectorBtnClass}>
                <span className='truncate'>{languageLabel}</span>
                <span className={`inline-flex transition-transform duration-200 ${languageOpen ? 'rotate-180' : ''}`}>
                  <Icon name='base-chevron-down-icon' width={10} height={10} />
                </span>
              </button>
            </Dropdown>
          </div>
        </div>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='shrink-0 text-text-default-base'>Voice</span>
          <div className={selectorDropdownWrapClass}>
            <Dropdown
              items={voiceItems}
              trigger='click'
              open={voiceOpen}
              onOpenChange={setVoiceOpen}
              onClick={(key) => setVoiceKey(String(key))}
              popupClassName={dropdownPopupClass}
              itemClassName={dropdownItemClass}
            >
              <button type='button' className={selectorBtnClass}>
                <span className='inline-flex min-w-0 items-center gap-1.5'>
                  <Icon name='videoNode-text-to-speech-voice' width={20} height={20} color='var(--color-icon-base)' />
                  <span className='truncate'>{voiceLabel}</span>
                </span>
                <span className={`inline-flex transition-transform duration-200 ${voiceOpen ? 'rotate-180' : ''}`}>
                  <Icon name='base-chevron-down-icon' width={11} height={11} />
                </span>
              </button>
            </Dropdown>
          </div>
        </div>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='shrink-0 text-text-default-base'>Emotion</span>
          <div className={selectorDropdownWrapClass}>
            <Dropdown
              items={emotionItems}
              trigger='click'
              open={emotionOpen}
              onOpenChange={setEmotionOpen}
              onClick={(key) => setEmotionKey(String(key))}
              popupClassName={dropdownPopupClass}
              itemClassName={dropdownItemClass}
            >
              <button type='button' className={selectorBtnClass}>
                <span className='truncate'>{emotionLabel}</span>
                <span className={`inline-flex transition-transform duration-200 ${emotionOpen ? 'rotate-180' : ''}`}>
                  <Icon name='base-chevron-down-icon' width={11} height={11} />
                </span>
              </button>
            </Dropdown>
          </div>
        </div>
      </div>

      <div className='flex shrink-0 flex-col gap-[10px]'>
        <div className='flex items-center justify-between'>
          <span className='text-[12px] font-semibold text-text-default-base'>Speed</span>
          <span className='min-w-[24px] text-right text-[12px] text-text-default-secondary'>{speed.toFixed(1)}</span>
        </div>
        <Slider
          className='nodrag nopan !m-0 !w-full'
          min={0}
          max={1}
          step={0.1}
          value={speed}
          activeColor='#5A5A5A'
          inactiveColor='#E3E3E3'
          trackHeight={6}
          thumbWidth={20}
          thumbHeight={16}
          thumbColor='#B3B3B3'
          onChange={(next) => setSpeed(Number(next.toFixed(1)))}
        />
      </div>

      <div className='flex shrink-0 items-center'>
        <Dropdown
          items={audioFxItems}
          trigger='click'
          open={audioFxOpen}
          onOpenChange={setAudioFxOpen}
          onClick={(key) => setAudioFxKey(String(key))}
          popupClassName={dropdownPopupClass}
          itemClassName={dropdownItemClass}
        >
          <button type='button' className='inline-flex h-6 items-center gap-1 rounded-[6px] bg-transparent px-1.5 text-[12px] text-text-default-base hover:bg-background-default-base-hover'>
            <span>{audioFxLabel}</span>
            <span className={`inline-flex transition-transform duration-200 ${audioFxOpen ? 'rotate-180' : ''}`}>
              <Icon name='base-chevron-down-icon' width={9} height={9} />
            </span>
          </button>
        </Dropdown>
        <div className='ml-auto flex items-center'>
          <div className='nodrag nopan flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>120</span>
          </div>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !ml-1 !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            aria-label='Send text-to-speech'
          />
        </div>
      </div>
    </div>
  );
};
