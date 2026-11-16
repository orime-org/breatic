// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { getLocale } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { languageName } from '@web/spaces/canvas/generate/audio-settings';
import { OptionList } from '@web/spaces/canvas/generate/OptionList';

interface SampleLanguagePickerProps {
  /** The languages the model's voice samples speak, as tags. */
  languages: readonly string[];
  /** The language samples play in now. */
  value: string | undefined;
  /** Called with the language the user picked. */
  onPick: (tag: string) => void;
}

/**
 * The language the voice list plays samples in (#1521): Gemini reads the
 * language from the script, so this only changes what the user hears before
 * picking a voice, never what is generated. The trigger has the shape of the
 * generation panel's single-choice menus (`ChoiceMenu`) at one fixed width, so
 * the search box beside it never moves; the list is the searchable, scrolling
 * one the panel's language rows use (`OptionList`), languages named in the
 * interface language and sorted by that name. A name cut short on the trigger
 * reads in full in its tooltip.
 * @param root0 - Component props.
 * @param root0.languages - The languages offered.
 * @param root0.value - The language held.
 * @param root0.onPick - Called with a newly picked language.
 * @returns The picker.
 */
export const SampleLanguagePicker = React.memo(function SampleLanguagePicker({
  languages,
  value,
  onPick,
}: SampleLanguagePickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const locale = getLocale();
  const options = React.useMemo(
    () => languages
      .map((tag) => ({ value: tag, label: languageName(tag, locale) ?? tag }))
      .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [languages, locale],
  );
  const named = options.find((option) => option.value === value)?.label ?? value ?? '';
  const pick = React.useCallback((tag: string | number): void => {
    onPick(String(tag));
    setOpen(false);
  }, [onPick]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type='button' variant={null} size={null} data-testid='generate-voice-language' onFocusCapture={suppressTooltipFocusOpen}
              className='flex h-8 w-[168px] shrink-0 items-center gap-1 whitespace-nowrap rounded-chrome border border-border bg-transparent px-2.5 text-sm text-foreground transition-colors hover-enabled:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'>
              <span className='shrink-0 text-foreground-secondary'>{t('canvas.generatePanel.voiceSampleLanguage')} ·</span>
              <span className='min-w-0 flex-1 truncate text-left'>{named}</span>
              <ChevronDown className='size-3.5 shrink-0 opacity-60' aria-hidden='true' />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side='top' portal>{named}</TooltipContent>
      </Tooltip>
      <PopoverContent side='bottom' align='end' avoidCollisions={false} className='w-[200px] p-0 shadow-md'>
        <OptionList
          options={options}
          value={value}
          onPick={pick}
          searchPlaceholder={t('canvas.generatePanel.audioLanguageSearch')}
          testIdPrefix='generate-voice-language'
        />
      </PopoverContent>
    </Popover>
  );
});
