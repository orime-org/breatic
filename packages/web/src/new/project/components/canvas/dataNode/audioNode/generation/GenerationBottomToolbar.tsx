/**
 * Generator-style dock below the audio node — single card ({@link LocalGenNode} parity): title bar, upstream strip, prompt, footer controls.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import CustomPopover from '@/components/base/popover';
import { cn } from '@/utils/classnames';
import type { AudioGenerationMode } from '@/new/project/types';
import GenComposerToolbar from '../../generatorNode/GenComposerToolbar';
import type { UpstreamItem } from '../../generatorNode/upstreamItems';

/** Matches {@link paletteOutputDefaults} `1004` shell width — audio dock aligns with palette preview geometry. */
const AUDIO_GENERATION_PANEL_WIDTH_PX = 472;

export type GenerationBottomToolbarProps = {
  panelTitle: string;
  upstreamItems: UpstreamItem[];
  onRemoveUpstreamItem?: (item: UpstreamItem) => void;
  onFocusComposer?: () => void;
  onClose: () => void;
  generationMode: AudioGenerationMode;
  stylesPrompt: string;
  lyrics: string;
  instrumental: boolean;
  onStylesChange: (value: string) => void;
  onLyricsChange: (value: string) => void;
  onInstrumentalChange: (value: boolean) => void;
  stylesTextAreaRef?: React.RefObject<HTMLTextAreaElement | null>;
  modelLabel: string;
  voiceLabel: string;
  languageLabel: string;
  creditEstimate: number;
  canSend: boolean;
  onGenerationMode: (mode: AudioGenerationMode) => void;
  onModelLabel: (label: string) => void;
  onVoiceLabel: (label: string) => void;
  onLanguageLabel: (label: string) => void;
  onSend: () => void;
};

const MODE_ITEMS: Array<{ key: AudioGenerationMode; label: string }> = [
  { key: 'tts', label: 'TTS' },
  { key: 'voice-clone', label: 'Voice clone' },
  { key: 'melody', label: 'Melody' },
  { key: 'lyrics-music', label: 'Lyrics → music' },
  { key: 'sfx', label: 'SFX / ambient' },
];

const DEMO_VOICES = ['沉稳高管', '创新设计师', '温柔客服'];

const MODEL_OPTIONS = ['Minimax Speech 02 hd'] as const;

const LANGUAGE_OPTIONS = ['中文-普通话', 'English'] as const;

/** Legacy persisted label without hyphen — maps to menu key. */
const normalizeLanguageLabel = (label: string): string =>
  label === '中文普通话' ? '中文-普通话' : label;

/** Popover stacks above menus — nested dropdowns must float higher than {@link CustomPopover}. */
const NESTED_DROPDOWN_FLOATING_CLASS = 'z-[650]';

const nestedDropdownSurfaceClass =
  'rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]';

const inputShellClass =
  'nodrag nopan w-full resize-none rounded-[4px] border-0 bg-transparent px-2 py-2 text-[13px] leading-snug text-text-default-base outline-none placeholder:text-text-default-tertiary focus:ring-0';

/** Header close control — matches {@link UpscaleBottomToolbar}. */
const audioGenHeaderCloseBtnClass =
  'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

const GenerationBottomToolbar: React.FC<GenerationBottomToolbarProps> = ({
  panelTitle,
  upstreamItems,
  onRemoveUpstreamItem,
  onFocusComposer,
  onClose,
  generationMode,
  stylesPrompt,
  lyrics,
  instrumental,
  onStylesChange,
  onLyricsChange,
  onInstrumentalChange,
  stylesTextAreaRef,
  modelLabel,
  voiceLabel,
  languageLabel,
  creditEstimate,
  canSend,
  onGenerationMode,
  onModelLabel,
  onVoiceLabel,
  onLanguageLabel,
  onSend,
}) => {
  const { t } = useTranslation();
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  /** Voice row preview via Web Speech API until real sample URLs exist. */
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  /**
   * Invalidates stale `utterance.onend` / `onerror` after {@link SpeechSynthesis.cancel}
   * or starting another preview — avoids wiping state when switching voices.
   */
  const voicePreviewGenRef = useRef(0);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      voicePreviewGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!modelPanelOpen && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      voicePreviewGenRef.current += 1;
      setPreviewingVoice(null);
    }
  }, [modelPanelOpen]);

  const toggleVoicePreview = useCallback(
    (voiceName: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

      if (previewingVoice === voiceName) {
        window.speechSynthesis.cancel();
        voicePreviewGenRef.current += 1;
        setPreviewingVoice(null);
        return;
      }

      window.speechSynthesis.cancel();
      voicePreviewGenRef.current += 1;
      const gen = voicePreviewGenRef.current;

      const utterance = new SpeechSynthesisUtterance(`这是${voiceName}音色的试听示例。`);
      utterance.lang = 'zh-CN';
      utterance.onend = () => {
        if (voicePreviewGenRef.current === gen) {
          setPreviewingVoice(null);
        }
      };
      utterance.onerror = () => {
        if (voicePreviewGenRef.current === gen) {
          setPreviewingVoice(null);
        }
      };

      setPreviewingVoice(voiceName);
      window.speechSynthesis.speak(utterance);
    },
    [previewingVoice],
  );

  const modeMenuItems: MenuItemType[] = useMemo(
    () =>
      MODE_ITEMS.map((m) => ({
        key: m.key,
        label: (
          <span className='text-[13px] font-medium text-text-default-base'>{m.label}</span>
        ),
      })),
    [],
  );

  const modelMenuItems: MenuItemType[] = useMemo(
    () =>
      MODEL_OPTIONS.map((label) => ({
        key: label,
        label: (
          <span className='flex items-center gap-2 text-[13px] font-medium text-text-default-base'>
            <span className='text-[18px] leading-none'>〰️</span>
            {label}
          </span>
        ),
      })),
    [],
  );

  const languageMenuItems: MenuItemType[] = useMemo(
    () =>
      LANGUAGE_OPTIONS.map((label) => ({
        key: label,
        label: <span className='text-[13px] font-medium text-text-default-base'>{label}</span>,
      })),
    [],
  );

  const modeLabel = MODE_ITEMS.find((m) => m.key === generationMode)?.label ?? 'TTS';

  const showLyricsStyles = generationMode === 'lyrics-music';
  const showInstrumental =
    generationMode === 'melody' || generationMode === 'lyrics-music' || generationMode === 'sfx';

  const stylesPlaceholder =
    generationMode === 'tts' || generationMode === 'voice-clone'
      ? 'Enter text to synthesize…'
      : 'Describe style, mood, instruments, reference…';

  const resolvedLanguageLabel = normalizeLanguageLabel(languageLabel);

  /** Footer pill copy — compact “Minimax 中文 沉稳高管” style (model + language token + voice). */
  const footerModelSummary = (() => {
    const langShort = resolvedLanguageLabel.includes('中文') ? '中文' : resolvedLanguageLabel;
    return `${modelLabel} ${langShort} ${voiceLabel}`.replace(/\s+/g, ' ').trim();
  })();

  const modelPanel = (
    <div className='w-[300px] rounded-[12px] border border-[var(--color-border-default-base)] bg-background-default-base p-4 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.18)]'>
      <div className='pb-3 text-[13px] font-semibold leading-snug text-text-default-base'>Select a Model</div>
      <label className='mb-2 block text-[11px] font-medium text-text-default-tertiary'>Model</label>
      <Dropdown
        trigger='click'
        placement='bottom-start'
        offset={6}
        items={modelMenuItems}
        selectedKeys={[modelLabel]}
        referenceClassName='block w-full'
        floatingClassName={NESTED_DROPDOWN_FLOATING_CLASS}
        popupClassName={nestedDropdownSurfaceClass}
        itemClassName='min-h-8 px-2 py-1.5'
        onClick={(key) => onModelLabel(key)}
      >
        <button
          type='button'
          className='nodrag nopan mb-3 flex w-full items-center justify-between rounded-[8px] border border-border-default-base bg-background-default-secondary px-2 py-2 text-left text-[13px] text-text-default-base'
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span className='flex min-w-0 items-center gap-2'>
            <span className='text-[18px] leading-none'>〰️</span>
            <span className='truncate'>{modelLabel}</span>
          </span>
          <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
        </button>
      </Dropdown>
      <label className='mb-2 block text-[11px] font-medium text-text-default-tertiary'>Language</label>
      <Dropdown
        trigger='click'
        placement='bottom-start'
        offset={6}
        items={languageMenuItems}
        selectedKeys={[resolvedLanguageLabel]}
        referenceClassName='block w-full'
        floatingClassName={NESTED_DROPDOWN_FLOATING_CLASS}
        popupClassName={nestedDropdownSurfaceClass}
        itemClassName='min-h-8 px-2 py-1.5'
        onClick={(key) => onLanguageLabel(key)}
      >
        <button
          type='button'
          className='nodrag nopan mb-3 flex w-full items-center justify-between rounded-[8px] border border-border-default-base bg-background-default-secondary px-2 py-2 text-left text-[13px] text-text-default-base'
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span className='truncate'>{resolvedLanguageLabel}</span>
          <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
        </button>
      </Dropdown>
      <div className='text-[11px] font-medium text-text-default-tertiary'>Voice</div>
      <ul className='mt-1 max-h-[160px] overflow-auto'>
        {DEMO_VOICES.map((name) => (
          <li key={name}>
            <div
              className={cn(
                'grid w-full grid-cols-[20px_minmax(0,1fr)] items-center gap-2 rounded-[8px] px-2 py-2 text-[13px] transition-colors',
                voiceLabel === name ? 'bg-background-default-secondary font-medium' : 'hover:bg-background-default-secondary',
              )}
            >
              <button
                type='button'
                className='nodrag nopan flex size-5 shrink-0 items-center justify-center justify-self-start border-0 bg-transparent p-0 hover:opacity-80'
                aria-label={
                  previewingVoice === name
                    ? t('project.audio.pauseVoicePreview', 'Pause preview')
                    : t('project.audio.playVoicePreview', 'Play preview')
                }
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleVoicePreview(name);
                }}
              >
                <Icon
                  name={
                    previewingVoice === name ? 'project-voice-preview-pause-icon' : 'project-voice-preview-play-icon'
                  }
                  width={20}
                  height={20}
                  color='var(--color-icon-base)'
                />
              </button>
              <button
                type='button'
                className='nodrag nopan min-w-0 truncate text-left leading-none text-text-default-base'
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  onVoiceLabel(name);
                  setModelPanelOpen(false);
                }}
              >
                {name}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div
      className='nodrag nopan pointer-events-auto rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
      style={{ width: AUDIO_GENERATION_PANEL_WIDTH_PX }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className='flex items-center justify-between gap-1 px-1 pb-1'>
        <div className='inline-flex min-w-0 items-center gap-1'>
          <Icon name='project-play-audio-icon' width={18} height={15} color='var(--color-icon-base)' />
          <span className='min-w-0 truncate text-sm font-bold text-text-default-base'>{panelTitle}</span>
        </div>
        <button
          type='button'
          className={audioGenHeaderCloseBtnClass}
          aria-label={t('project.toolbar.closePanel', 'Close')}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} />
        </button>
      </div>

      <div className='flex flex-col gap-2'>
        <GenComposerToolbar
          upstreamItems={upstreamItems}
          onRemoveUpstreamItem={onRemoveUpstreamItem}
          onLayoutClick={onFocusComposer}
        />

        <div className='nodrag nopan rounded-[4px] border border-[var(--color-border-default-base)] bg-background-default-base'>
          {showInstrumental ? (
            <div className='flex items-center justify-between gap-2 border-b border-border-default-base px-2 py-1.5'>
              <span className='text-[11px] font-medium text-text-default-tertiary'>Instrumental</span>
              <button
                type='button'
                role='switch'
                aria-checked={instrumental}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onInstrumentalChange(!instrumental);
                }}
                className={cn(
                  'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                  instrumental ? 'bg-[var(--color-success-default-base,#22c55e)]' : 'bg-background-default-secondary',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-5 w-5 rounded-full bg-background-default-base shadow transition-transform',
                    instrumental ? 'left-[22px]' : 'left-0.5',
                  )}
                />
              </button>
            </div>
          ) : null}

          {showLyricsStyles ? (
            <div className='grid grid-cols-2 divide-x divide-border-default-base'>
              <label className='flex min-h-0 flex-col gap-0.5 p-2'>
                <span className='text-[11px] font-medium text-text-default-tertiary'>Lyrics</span>
                <textarea
                  value={lyrics}
                  onChange={(e) => onLyricsChange(e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  placeholder='Lyrics…'
                  className={cn(inputShellClass, 'min-h-[72px]')}
                />
              </label>
              <label className='flex min-h-0 flex-col gap-0.5 p-2'>
                <span className='text-[11px] font-medium text-text-default-tertiary'>Styles</span>
                <textarea
                  ref={stylesTextAreaRef}
                  value={stylesPrompt}
                  onChange={(e) => onStylesChange(e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  placeholder={stylesPlaceholder}
                  className={cn(inputShellClass, 'min-h-[72px]')}
                />
              </label>
            </div>
          ) : (
            <textarea
              ref={stylesTextAreaRef}
              value={stylesPrompt}
              onChange={(e) => onStylesChange(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder={stylesPlaceholder}
              className={cn(inputShellClass, 'h-[88px] min-h-0')}
            />
          )}
        </div>
      </div>

      <div className='nodrag nopan mt-3 flex min-h-[44px] items-center gap-2 px-1'>
        <Dropdown
          trigger='click'
          placement='top-start'
          offset={8}
          items={modeMenuItems}
          onClick={(key) => onGenerationMode(key as AudioGenerationMode)}
          popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
          itemClassName='min-h-8 px-2 py-1.5'
        >
          <button
            type='button'
            className='flex h-8 shrink-0 items-center gap-1 rounded-[4px] bg-[#F3F3F3] px-2.5 text-[13px] font-medium text-text-default-base hover:bg-[#EBEBEB]'
          >
            <span className='max-w-[72px] truncate'>{modeLabel}</span>
            <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
          </button>
        </Dropdown>

        <CustomPopover
          className='z-[600] min-w-0 flex-1'
          trigger='click'
          position='top'
          open={modelPanelOpen}
          onOpenChange={setModelPanelOpen}
          popupClassName='border-0 bg-transparent p-0 shadow-none'
          htmlContent={modelPanel}
          btnElement={
            <button
              type='button'
              className='flex h-8 min-h-8 w-full min-w-0 max-w-full items-center gap-1.5 rounded-full border border-[#E0E0E0] bg-white px-3 text-left text-[12px] leading-tight text-text-default-base shadow-none hover:bg-[#FAFAFA]'
            >
              <span className='flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border border-[#E8E8E8] bg-[#F7F7F7]'>
                <Icon name='videoNode-adjust' width={12} height={12} color='var(--color-icon-base)' />
              </span>
              <span className='min-w-0 flex-1 truncate'>{footerModelSummary}</span>
            </button>
          }
        />

        <div className='flex shrink-0 items-center gap-0.5 tabular-nums text-[13px] font-medium text-text-default-base'>
          <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
          <span>{creditEstimate}</span>
        </div>

        {/* Matches {@link AgentSendButton} / generator node send control */}
        <Button
          type='primary'
          size='medium'
          shape='round'
          disabled={!canSend}
          aria-label='Generate'
          icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
          onClick={() => {
            if (canSend) onSend();
          }}
          className='!h-[28px] w-[52px] shrink-0 !border-[#35C838] !bg-[#35C838] !py-[2px] !pl-[16px] !pr-[12px] hover:!border-[#35C838] hover:!bg-[#35C838] disabled:!border-[#CDCDCD] disabled:!bg-[#CDCDCD]'
        />
      </div>
    </div>
  );
};

export default GenerationBottomToolbar;
