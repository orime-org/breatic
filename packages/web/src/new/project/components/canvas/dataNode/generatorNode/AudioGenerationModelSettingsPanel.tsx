/**
 * Popover body for audio generator model / language / voice — shared by {@link GeneratorModelFooter} usages (audio dock + gen1004).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { cn } from '@/utils/classnames';

const LANGUAGE_OPTIONS = ['中文-普通话', 'English'] as const;

const DEMO_VOICES = ['沉稳高管', '创新设计师', '温柔客服'];

/** Legacy persisted label without hyphen — maps to menu key. */
const normalizeLanguageLabel = (label: string): string =>
  label === '中文普通话' ? '中文-普通话' : label;

const NESTED_DROPDOWN_FLOATING_CLASS = 'z-[650]';

const nestedDropdownSurfaceClass =
  'rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]';

export type AudioGenerationModelSettingsPanelProps = {
  /** Static list for the active footer mode (TTS vs Song / SFX / Melody). */
  modelOptions: readonly string[];
  modelLabel: string;
  voiceLabel: string;
  languageLabel: string;
  onModelLabel: (label: string) => void;
  onVoiceLabel: (label: string) => void;
  onLanguageLabel: (label: string) => void;
  /** Speech modes show language + voice; music/SFX modes only pick a model. */
  showVoiceAndLanguage?: boolean;
  /** Fire after choosing a voice — parent may close the popover. */
  onVoiceCommit?: () => void;
};

const AudioGenerationModelSettingsPanel: React.FC<AudioGenerationModelSettingsPanelProps> = ({
  modelOptions,
  modelLabel,
  voiceLabel,
  languageLabel,
  onModelLabel,
  onVoiceLabel,
  onLanguageLabel,
  showVoiceAndLanguage = true,
  onVoiceCommit,
}) => {
  const { t } = useTranslation();
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const voicePreviewGenRef = useRef(0);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      voicePreviewGenRef.current += 1;
    };
  }, []);

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

  const modelMenuItems: MenuItemType[] = useMemo(
    () =>
      modelOptions.map((label) => ({
        key: label,
        label: (
          <span className='flex items-center gap-2 text-[13px] font-medium text-text-default-base'>
            <span className='text-[18px] leading-none'>〰️</span>
            {label}
          </span>
        ),
      })),
    [modelOptions],
  );

  const languageMenuItems: MenuItemType[] = useMemo(
    () =>
      LANGUAGE_OPTIONS.map((label) => ({
        key: label,
        label: <span className='text-[13px] font-medium text-text-default-base'>{label}</span>,
      })),
    [],
  );

  const resolvedLanguageLabel = normalizeLanguageLabel(languageLabel);

  return (
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
      {showVoiceAndLanguage ? (
        <>
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
                      onVoiceCommit?.();
                    }}
                  >
                    {name}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
};

export default AudioGenerationModelSettingsPanel;
