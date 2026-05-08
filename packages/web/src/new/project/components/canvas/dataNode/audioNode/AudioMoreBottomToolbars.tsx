/**
 * Bottom chrome for audio toolbar “More” menu — matches {@link AudioNormalizeBottomToolbar} / {@link AudioEnhanceBottomToolbar} patterns.
 */
import React, { memo, useEffect, useState } from 'react';
import type { VideoRef } from '@/new/project/components/canvas/common/CanvasVideo';
import Slider from '@/components/base/slider';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import PlaybackPanel from '../videoNode/playback/PlaybackPanel';

const RAIL_CREDIT = 120;
const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const sliderChrome = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;

/** Playback strip only — close buttons live inside each rail. */
type ShellPlaybackProps = {
  active: boolean;
  videoRef?: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  volume?: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
};

const PlaybackShell: React.FC<
  ShellPlaybackProps & { children: React.ReactNode }
> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime = 0,
  duration = 0,
  isPlaying = false,
  volume = 1,
  fullscreenTargetRef,
  children,
}) => {
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
        {children}
      </div>
    </div>
  );
};

export type AudioTranscriptionBottomToolbarProps = ShellPlaybackProps & {
  onClose: () => void;
  onSend?: (payload: { notes: string }) => void;
};

export const AudioTranscriptionBottomToolbar: React.FC<AudioTranscriptionBottomToolbarProps> = memo(
  ({ active, onClose, onSend, ...playback }) => {
    const [notes, setNotes] = useState('');
    useEffect(() => {
      if (!active) return;
      setNotes('');
    }, [active]);
    const canSend = notes.trim().length > 0;
    return (
      <PlaybackShell active={active} {...playback}>
        <div
          className='nodrag nopan w-[430px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='mb-2 flex items-center justify-between gap-2'>
            <div className='inline-flex items-center gap-1'>
              <Icon name='project-chat-text-doc-icon' width={18} height={18} color='var(--color-icon-base)' />
              <span className='text-[14px] font-semibold text-text-default-base'>Transcription (ASR)</span>
            </div>
            <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close transcription toolbar'>
              <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} />
            </button>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder='Optional context or vocabulary hints for the transcript…'
            className='mb-3 h-[96px] w-full resize-none rounded-[8px] border border-border-default-base bg-transparent px-2 py-1.5 text-[13px] text-text-default-base outline-none placeholder:text-text-default-tertiary'
          />
          <div className='flex items-center justify-end gap-2'>
            <div className='inline-flex items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
              <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
              <span>{RAIL_CREDIT}</span>
            </div>
            <Button
              type='primary'
              shape='round'
              size='medium'
              className='!h-[28px] !bg-[#2FB344] !px-3 hover:!bg-[#28A13D] disabled:!bg-[#D8D8D8]'
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
              disabled={!canSend}
              onClick={() => onSend?.({ notes: notes.trim() })}
            />
          </div>
        </div>
      </PlaybackShell>
    );
  },
);

AudioTranscriptionBottomToolbar.displayName = 'AudioTranscriptionBottomToolbar';

export type AudioCompressionBottomToolbarProps = ShellPlaybackProps & {
  onClose: () => void;
  onSend?: (payload: { amount: number }) => void;
};

export const AudioCompressionBottomToolbar: React.FC<AudioCompressionBottomToolbarProps> = memo(
  ({ active, onClose, onSend, ...playback }) => {
    const [amount, setAmount] = useState(55);
    useEffect(() => {
      if (!active) return;
      setAmount(55);
    }, [active]);
    return (
      <PlaybackShell active={active} {...playback}>
        <div
          className='nodrag nopan flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='inline-flex h-8 items-center gap-1'>
            <Icon name='videoNode-adjust' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Compression</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <span className='text-[13px] font-medium text-text-default-secondary'>Amount</span>
          <div className='flex h-7 w-[130px] items-center px-1'>
            <Slider className='nodrag !m-0 !w-full' min={0} max={100} step={1} value={amount} onChange={setAmount} {...sliderChrome} />
          </div>
          <span className='min-w-[40px] text-center text-[13px] font-medium tabular-nums text-text-default-secondary'>{amount}%</span>
          <div className='ml-auto flex items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>{RAIL_CREDIT}</span>
          </div>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !ml-1 !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={() => onSend?.({ amount })}
          />
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close compression toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </PlaybackShell>
    );
  },
);

AudioCompressionBottomToolbar.displayName = 'AudioCompressionBottomToolbar';

export type AudioEqBottomToolbarProps = ShellPlaybackProps & {
  onClose: () => void;
  onSend?: (payload: { low: number; mid: number; high: number }) => void;
};

export const AudioEqBottomToolbar: React.FC<AudioEqBottomToolbarProps> = memo(({ active, onClose, onSend, ...playback }) => {
  const [low, setLow] = useState(0);
  const [mid, setMid] = useState(0);
  const [high, setHigh] = useState(0);
  useEffect(() => {
    if (!active) return;
    setLow(0);
    setMid(0);
    setHigh(0);
  }, [active]);
  return (
    <PlaybackShell active={active} {...playback}>
      <div
        className='nodrag nopan w-[520px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='mb-3 flex items-center justify-between'>
          <div className='inline-flex items-center gap-1'>
            <Icon name='videoNode-adjust' width={18} height={18} color='var(--color-icon-base)' />
            <span className='text-[14px] font-semibold text-text-default-base'>EQ</span>
          </div>
          <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close EQ toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} />
          </button>
        </div>
        <div className='grid grid-cols-3 gap-3'>
          {[
            { label: 'Low', v: low, set: setLow },
            { label: 'Mid', v: mid, set: setMid },
            { label: 'High', v: high, set: setHigh },
          ].map((band) => (
            <div key={band.label} className='flex flex-col gap-1'>
              <span className='text-center text-[11px] font-medium uppercase tracking-wide text-text-default-secondary'>{band.label}</span>
              <Slider className='nodrag !w-full' min={-12} max={12} step={1} value={band.v} onChange={band.set} {...sliderChrome} />
              <span className='text-center text-[12px] font-medium tabular-nums text-text-default-secondary'>{band.v > 0 ? `+${band.v}` : band.v} dB</span>
            </div>
          ))}
        </div>
        <div className='mt-3 flex items-center justify-end gap-2 border-t border-[#EBEBEB] pt-3'>
          <div className='inline-flex items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>{RAIL_CREDIT}</span>
          </div>
          <Button
            type='primary'
            shape='round'
            className='!h-[28px] !bg-[#2FB344] !px-3 hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={() => onSend?.({ low, mid, high })}
          />
        </div>
      </div>
    </PlaybackShell>
  );
});

AudioEqBottomToolbar.displayName = 'AudioEqBottomToolbar';

export type AudioPanBottomToolbarProps = ShellPlaybackProps & {
  onClose: () => void;
  onSend?: (payload: { pan: number }) => void;
};

export const AudioPanBottomToolbar: React.FC<AudioPanBottomToolbarProps> = memo(({ active, onClose, onSend, ...playback }) => {
  const [pan, setPan] = useState(0);
  useEffect(() => {
    if (!active) return;
    setPan(0);
  }, [active]);
  const panLabel = pan <= -33 ? 'L' : pan >= 33 ? 'R' : 'C';
  return (
    <PlaybackShell active={active} {...playback}>
      <div
        className='nodrag nopan flex h-[40px] items-center gap-2 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='inline-flex h-8 items-center gap-1'>
          <Icon name='videoNode-speed' width={22} height={18} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Pan</span>
        </div>
        <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
        <span className='text-[11px] font-semibold text-text-default-tertiary'>L</span>
        <div className='flex h-7 w-[160px] items-center px-1'>
          <Slider className='nodrag !m-0 !w-full' min={-100} max={100} step={1} value={pan} onChange={setPan} {...sliderChrome} />
        </div>
        <span className='text-[11px] font-semibold text-text-default-tertiary'>R</span>
        <span className='min-w-[28px] text-center text-[12px] font-semibold tabular-nums text-text-default-secondary'>{panLabel}</span>
        <div className='ml-auto flex items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
          <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
          <span>{RAIL_CREDIT}</span>
        </div>
        <Button
          type='primary'
          shape='round'
          className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
          icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
          onClick={() => onSend?.({ pan })}
        />
        <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
        <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close pan toolbar'>
          <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
        </button>
      </div>
    </PlaybackShell>
  );
});

AudioPanBottomToolbar.displayName = 'AudioPanBottomToolbar';

export type ReverbRoom = 'small' | 'medium' | 'large' | 'hall';

export type AudioReverbBottomToolbarProps = ShellPlaybackProps & {
  onClose: () => void;
  onSend?: (payload: { mix: number; room: ReverbRoom }) => void;
};

const roomOptions: Array<{ key: ReverbRoom; label: string }> = [
  { key: 'small', label: 'Small room' },
  { key: 'medium', label: 'Medium room' },
  { key: 'large', label: 'Large room' },
  { key: 'hall', label: 'Hall' },
];

const reverbMenuItems: MenuItemType[] = roomOptions.map((opt) => ({
  key: opt.key,
  label: <span className='text-[13px] font-medium text-text-default-base'>{opt.label}</span>,
}));

export const AudioReverbBottomToolbar: React.FC<AudioReverbBottomToolbarProps> = memo(({ active, onClose, onSend, ...playback }) => {
  const [mix, setMix] = useState(35);
  const [room, setRoom] = useState<ReverbRoom>('medium');
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!active) return;
    setMix(35);
    setRoom('medium');
  }, [active]);
  const roomLabel = roomOptions.find((r) => r.key === room)?.label ?? roomOptions[1].label;
  return (
    <PlaybackShell active={active} {...playback}>
      <div
        className='nodrag nopan flex min-h-[40px] flex-wrap items-center gap-x-2 gap-y-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[6px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='inline-flex h-8 items-center gap-1'>
          <Icon name='videoNode-animate' width={20} height={20} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Reverb</span>
        </div>
        <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
        <span className='text-[12px] font-medium text-text-default-secondary'>Room</span>
        <Dropdown
          trigger='click'
          placement='top-start'
          offset={6}
          items={reverbMenuItems}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onClick={(key) => {
            setRoom(key as ReverbRoom);
            setMenuOpen(false);
          }}
          popupClassName='rounded-[8px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
          itemClassName='min-h-8 px-2 py-1.5'
        >
          <button
            type='button'
            className='nodrag nopan inline-flex h-[28px] max-w-[200px] items-center gap-1 rounded-[6px] px-2 hover:bg-background-default-base-hover'
            aria-expanded={menuOpen}
          >
            <span className='truncate text-[13px] font-medium text-text-default-base'>{roomLabel}</span>
            <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
          </button>
        </Dropdown>
        <span className='text-[12px] font-medium text-text-default-secondary'>Mix</span>
        <div className='flex h-7 w-[120px] items-center px-1'>
          <Slider className='nodrag !m-0 !w-full' min={0} max={100} step={1} value={mix} onChange={setMix} {...sliderChrome} />
        </div>
        <span className='min-w-[36px] text-[12px] font-medium tabular-nums text-text-default-secondary'>{mix}%</span>
        <div className='ml-auto flex items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
          <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
          <span>{RAIL_CREDIT}</span>
        </div>
        <Button
          type='primary'
          shape='round'
          className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
          icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
          onClick={() => onSend?.({ mix, room })}
        />
        <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
        <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close reverb toolbar'>
          <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
        </button>
      </div>
    </PlaybackShell>
  );
});

AudioReverbBottomToolbar.displayName = 'AudioReverbBottomToolbar';

export type VoiceEnhancePreset = 'podcast' | 'dialogue' | 'broadcast';

export type AudioVoiceEnhancementBottomToolbarProps = ShellPlaybackProps & {
  onClose: () => void;
  onSend?: (payload: { preset: VoiceEnhancePreset }) => void;
};

const voicePresets: Array<{ key: VoiceEnhancePreset; label: string }> = [
  { key: 'podcast', label: 'Podcast clarity' },
  { key: 'dialogue', label: 'Film / dialogue' },
  { key: 'broadcast', label: 'Broadcast voice' },
];

const voiceMenuItems: MenuItemType[] = voicePresets.map((opt) => ({
  key: opt.key,
  label: (
    <div className='flex w-full min-w-[220px] items-center justify-between gap-3'>
      <span className='text-[13px] font-medium text-text-default-base'>{opt.label}</span>
      <div className='flex items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-base'>
        <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
        <span>{RAIL_CREDIT}</span>
      </div>
    </div>
  ),
}));

export const AudioVoiceEnhancementBottomToolbar: React.FC<AudioVoiceEnhancementBottomToolbarProps> = memo(
  ({ active, onClose, onSend, ...playback }) => {
    const [preset, setPreset] = useState<VoiceEnhancePreset>('podcast');
    const [menuOpen, setMenuOpen] = useState(false);
    useEffect(() => {
      if (!active) return;
      setPreset('podcast');
    }, [active]);
    const label = voicePresets.find((p) => p.key === preset)?.label ?? voicePresets[0].label;
    return (
      <PlaybackShell active={active} {...playback}>
        <div
          className='nodrag nopan flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='inline-flex h-8 items-center gap-1'>
            <Icon name='project-excalidraw-top-enhance-icon' width={18} height={15} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Voice Enhancement</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Dropdown
            trigger='click'
            placement='top-start'
            offset={8}
            items={voiceMenuItems}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onClick={(key) => {
              setPreset(key as VoiceEnhancePreset);
              setMenuOpen(false);
            }}
            popupClassName='rounded-[8px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
            itemClassName='min-h-9 px-2 py-1.5'
          >
            <button
              type='button'
              className='nodrag nopan inline-flex h-[28px] max-w-[260px] items-center gap-1 rounded-[6px] px-2 hover:bg-background-default-base-hover'
              aria-expanded={menuOpen}
            >
              <span className='truncate text-[13px] font-medium text-text-default-base'>{label}</span>
              <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
            </button>
          </Dropdown>
          <div className='nodrag nopan ml-auto flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
            <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
            <span>{RAIL_CREDIT}</span>
          </div>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={() => onSend?.({ preset })}
          />
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close voice enhancement toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </PlaybackShell>
    );
  },
);

AudioVoiceEnhancementBottomToolbar.displayName = 'AudioVoiceEnhancementBottomToolbar';

export type AudioPitchShiftBottomToolbarProps = ShellPlaybackProps & {
  onClose: () => void;
  onSend?: (payload: { semitones: number }) => void;
};

export const AudioPitchShiftBottomToolbar: React.FC<AudioPitchShiftBottomToolbarProps> = memo(({ active, onClose, onSend, ...playback }) => {
  const [semi, setSemi] = useState(0);
  useEffect(() => {
    if (!active) return;
    setSemi(0);
  }, [active]);
  return (
    <PlaybackShell active={active} {...playback}>
      <div
        className='nodrag nopan flex h-[40px] items-center gap-2 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='inline-flex h-8 items-center gap-1'>
          <Icon name='videoNode-interpolate' width={20} height={20} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Pitch Shift</span>
        </div>
        <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
        <span className='text-[12px] font-medium text-text-default-secondary'>Semitones</span>
        <div className='flex h-7 w-[180px] items-center px-1'>
          <Slider className='nodrag !m-0 !w-full' min={-24} max={24} step={1} value={semi} onChange={setSemi} {...sliderChrome} />
        </div>
        <span className='min-w-[44px] text-center text-[13px] font-semibold tabular-nums text-text-default-secondary'>
          {semi > 0 ? `+${semi}` : semi}
        </span>
        <div className='ml-auto flex items-center gap-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
          <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
          <span>{RAIL_CREDIT}</span>
        </div>
        <Button
          type='primary'
          shape='round'
          className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
          icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
          onClick={() => onSend?.({ semitones: semi })}
        />
        <Divider type='vertical' className='mx-1 h-[18px] bg-[#D0D0D0]' />
        <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close pitch shift toolbar'>
          <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
        </button>
      </div>
    </PlaybackShell>
  );
});

AudioPitchShiftBottomToolbar.displayName = 'AudioPitchShiftBottomToolbar';
