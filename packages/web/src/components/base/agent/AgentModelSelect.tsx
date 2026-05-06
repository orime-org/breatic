import React, { memo, useState } from 'react';
import { cn } from '@/utils/classnames';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/button';
import CustomPopover from '@/ui/popover';
import { Tabs, type TabsItem } from '@/ui/tabs';
import Select, { type SelectOption } from '@/ui/select';

import claudePng from '@/assets/images/model/claude.png';
import deepseekPng from '@/assets/images/model/deepseek.png';
import dreaminaPng from '@/assets/images/model/dreamina.png';
import elevenlabsTurboPng from '@/assets/images/model/elevenlabs_turbo.png';
import fluxKontextProPng from '@/assets/images/model/flux_kontext_pro.png';
import geminiPng from '@/assets/images/model/gemini.png';
import gptImagePng from '@/assets/images/model/gpt_image.png';
import ideogramPng from '@/assets/images/model/ideogram.png';
import klingPng from '@/assets/images/model/kling.png';
import minimaxMusicPng from '@/assets/images/model/minimax_music.png';
import qwenPng from '@/assets/images/model/qwen.png';
import seedreamPng from '@/assets/images/model/seedream.png';
import soraPng from '@/assets/images/model/sora.png';
import syncLipsyncPng from '@/assets/images/model/sync_lipsync.png';

export interface ModelOption {
  id: string;
  label: string;
  imageSrc: string;
}

export interface ModelSelectProps {
  disabled?: boolean;
  /** Model rows; optional when using built-ins */
  options?: ModelOption[];
  /** Controlled selected id */
  value?: string;
  onChange?: (id: string, label: string) => void;
  qualityValue?: string;
  onQualityChange?: (value: string) => void;
  aspectValue?: string;
  onAspectChange?: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const modelOptions: ModelOption[] = [
  { id: 'claude', label: 'Claude', imageSrc: claudePng },
  { id: 'deepseek', label: 'DeepSeek', imageSrc: deepseekPng },
  { id: 'dreamina', label: 'Dreamina', imageSrc: dreaminaPng },
  { id: 'elevenlabs_turbo', label: 'ElevenLabs Turbo', imageSrc: elevenlabsTurboPng },
  { id: 'flux_kontext_pro', label: 'Flux Kontekst Pro', imageSrc: fluxKontextProPng },
  { id: 'gemini', label: 'Gemini', imageSrc: geminiPng },
  { id: 'gpt_image', label: 'GPT Image', imageSrc: gptImagePng },
  { id: 'ideogram', label: 'Ideogram', imageSrc: ideogramPng },
  { id: 'kling', label: 'Kling', imageSrc: klingPng },
  { id: 'minimax_music', label: 'MiniMax Music', imageSrc: minimaxMusicPng },
  { id: 'qwen', label: 'Qwen', imageSrc: qwenPng },
  { id: 'seedream', label: 'Seedream', imageSrc: seedreamPng },
  { id: 'sora', label: 'Sora', imageSrc: soraPng },
  { id: 'sync_lipsync', label: 'Sync Lipsync', imageSrc: syncLipsyncPng },
];

const ModelSection: React.FC<{
  modelValue: string;
  setModelValue: (v: string) => void;
}> = ({ modelValue, setModelValue }) => {
  const selectOptions: SelectOption[] = modelOptions.map((opt) => ({
    value: opt.id,
    label: opt.label,
  }));

  const renderLabel = (option: SelectOption | undefined) => {
    if (!option) return 'Select a Model';
    const matched = modelOptions.find((m) => m.id === option.value);
    return (
      <span className='flex h-full items-center gap-2 leading-none'>
        {matched && (
          <img
            src={matched.imageSrc}
            alt={matched.label}
            className='h-[20px] w-[20px] shrink-0 rounded-[4px] object-cover'
          />
        )}
        <span className='inline-flex items-center text-text-default-base text-sm leading-none'>
          {option.label}
        </span>
      </span>
    );
  };

  const renderOption = (option: SelectOption, selected: boolean) => {
    const matched = modelOptions.find((m) => m.id === option.value);
    return (
      <div className={cn('flex items-center gap-2', selected && 'font-medium')}>
        {matched && (
          <img
            src={matched.imageSrc}
            alt={matched.label}
            className='h-[18px] w-[18px] shrink-0 rounded-[4px] object-cover'
          />
        )}
        <span className='text-text-default-base text-sm leading-none'>{option.label}</span>
      </div>
    );
  };

  return (
    <div className='flex flex-col gap-2'>
      <span className='text-text-default-base text-xs font-medium'>Select a Model</span>
      <Select
        options={selectOptions}
        value={modelValue}
        onChange={(v) => setModelValue(String(v))}
        labelRender={renderLabel}
        optionRender={renderOption}
        size='middle'
        type='outlined'
        className='w-full'
      />
    </div>
  );
};

const qualityOptions = [
  { id: '1k', label: '1K', iconName: 'project-quality-1k-icon' as const },
  { id: '2k', label: '2K', iconName: 'project-quality-2k-icon' as const },
  { id: '4k', label: '4K', iconName: 'project-quality-4k-icon' as const },
  { id: '4k+', label: '4K+', iconName: 'project-quality-4k-plus-icon' as const },
] as const;

const aspectOptions = [
  { id: '1:1', label: '1:1', iconName: 'aspectRatio-crop-square' as const },
  { id: '2:3', label: '2:3', iconName: 'aspectRatio-crop-2-3' as const },
  { id: '3:2', label: '3:2', iconName: 'aspectRatio-crop-3-2' as const },
  { id: '9:16', label: '9:16', iconName: 'aspectRatio-crop-9-16' as const },
  { id: '16:9', label: '16:9', iconName: 'aspectRatio-crop-16-9' as const },
] as const;

const QualitySection: React.FC<{
  qualityValue: string;
  setQualityValue: (v: string) => void;
}> = ({ qualityValue, setQualityValue }) => {
  const qualityItems: TabsItem[] = qualityOptions.map((opt) => ({
    value: opt.id,
    label: (
      <span className='inline-flex items-center gap-1.5'>
        <Icon name={opt.iconName} width={18} height={18} className='shrink-0 text-icon-base' />
        {opt.label}
      </span>
    ),
  }));
  const qualitySelectedIndex = qualityOptions.findIndex((o) => o.id === qualityValue);
  return (
    <div className='flex flex-col gap-2'>
      <span className='text-text-default-base text-xs'>Quality</span>
      <Tabs
        items={qualityItems}
        selectedIndex={qualitySelectedIndex >= 0 ? qualitySelectedIndex : 0}
        onChange={(index) => setQualityValue(qualityOptions[index].id)}
        TabListClass='mb-0 h-11 py-1.5 px-1.5 w-full'
        TabClass='flex-1 h-8'
      />
    </div>
  );
};

const AspectSection: React.FC<{
  aspectValue: string;
  setAspectValue: (v: string) => void;
}> = ({ aspectValue, setAspectValue }) => {
  const aspectItems: TabsItem[] = aspectOptions.map((opt) => ({
    value: opt.id,
    label: (
      <span className='inline-flex items-center gap-1.5'>
        <Icon name={opt.iconName} width={18} height={18} className='shrink-0 text-icon-base' />
        {opt.label}
      </span>
    ),
  }));
  const aspectSelectedIndex = aspectOptions.findIndex((o) => o.id === aspectValue);
  return (
    <div className='flex flex-col gap-2'>
      <span className='text-text-default-base text-xs'>Aspect Ratio</span>
      <Tabs
        items={aspectItems}
        selectedIndex={aspectSelectedIndex >= 0 ? aspectSelectedIndex : 0}
        onChange={(index) => setAspectValue(aspectOptions[index].id)}
        TabListClass='mb-0 h-11 py-1.5 px-1.5 w-full'
        TabClass='flex-1 h-8'
      />
    </div>
  );
};

const ModelSelectContent: React.FC<{
  onClose: () => void;
  modelValue: string;
  setModelValue: (v: string) => void;
  qualityValue: string;
  setQualityValue: (v: string) => void;
  aspectValue: string;
  setAspectValue: (v: string) => void;
}> = ({ onClose: _onClose, modelValue, setModelValue, qualityValue, setQualityValue, aspectValue, setAspectValue }) => {
  return (
    <div
      className='w-[430px] rounded-xl border border-[var(--color-border-default-base)] bg-[var(--color-background-default-base)] p-3 shadow-lg'
      onClick={(e) => e.stopPropagation()}
    >
      <ModelSection modelValue={modelValue} setModelValue={setModelValue} />
      <div className='mt-3'>
        <QualitySection qualityValue={qualityValue} setQualityValue={setQualityValue} />
      </div>
      <div className='mt-3'>
        <AspectSection aspectValue={aspectValue} setAspectValue={setAspectValue} />
      </div>
    </div>
  );
};

const AgentModelSelectComponent: React.FC<ModelSelectProps> = ({
  disabled = false,
  options: _options = [],
  value,
  onChange,
  qualityValue,
  onQualityChange,
  aspectValue,
  onAspectChange,
  onOpenChange,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const [localModelValue, setLocalModelValue] = useState('gemini');
  const [localQualityValue, setLocalQualityValue] = useState('2k');
  const [localAspectValue, setLocalAspectValue] = useState('3:2');
  const modelValue = value ?? localModelValue;
  const currentQualityValue = qualityValue ?? localQualityValue;
  const currentAspectValue = aspectValue ?? localAspectValue;

  const selectedModel = modelOptions.find((m) => m.id === modelValue);
  const qualityLabel = qualityOptions.find((q) => q.id === currentQualityValue)?.label ?? currentQualityValue;
  const aspectLabel = aspectOptions.find((a) => a.id === currentAspectValue)?.label ?? currentAspectValue;
  const displayLabel = selectedModel ? `${String(selectedModel.label)} ${qualityLabel} ${aspectLabel}` : 'Auto';
  const handleModelChange = (next: string) => {
    if (value === undefined) setLocalModelValue(next);
    const nextLabel = modelOptions.find((m) => m.id === next)?.label ?? next;
    onChange?.(next, nextLabel);
  };
  const handleQualityChange = (next: string) => {
    if (qualityValue === undefined) setLocalQualityValue(next);
    onQualityChange?.(next);
  };
  const handleAspectChange = (next: string) => {
    if (aspectValue === undefined) setLocalAspectValue(next);
    onAspectChange?.(next);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <CustomPopover
      className='z-[540]'
      trigger='click'
      position='top-start'
      open={open}
      onOpenChange={handleOpenChange}
      htmlContent={
        <ModelSelectContent
          onClose={() => handleOpenChange(false)}
          modelValue={modelValue}
          setModelValue={handleModelChange}
          qualityValue={currentQualityValue}
          setQualityValue={handleQualityChange}
          aspectValue={currentAspectValue}
          setAspectValue={handleAspectChange}
        />
      }
      popupClassName='p-0 min-w-0'
      btnElement={
        <Button
          type='default'
          shape='round'
          disabled={disabled}
          className={cn('px-3 !h-[28px] max-w-[140px] min-w-0 overflow-hidden', className)}
          aria-label='Select model'
          icon={
            selectedModel ? (
              <img
                src={selectedModel.imageSrc}
                alt={selectedModel.label}
                className='h-[20px] w-[20px] rounded-[3px] object-cover'
              />
            ) : undefined
          }
        >
          <span className='truncate'>{displayLabel}</span>
        </Button>
      }
      disabled={disabled}
    />
  );
};

const AgentModelSelect = memo(AgentModelSelectComponent);
export default AgentModelSelect;

