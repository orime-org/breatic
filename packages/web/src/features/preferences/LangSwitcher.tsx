// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Globe } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import type { Locale } from '@breatic/shared';
import {
  langFor,
  useLocaleSwitch,
} from '@web/features/preferences/supported-langs';
import { TopBarTextIconButton } from '@web/features/preferences/TopBarTextIconButton';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Language switcher · TopBar group A (mock § TopBar v4.0).
 *
 * Renders the active locale's single-char glyph inline; clicking opens a
 * popover of all supported locales. Locale data + wiring come from the
 * shared `useLocaleSwitch()` core (`@web/features/preferences/supported-langs`)
 * — the i18n engine is the single source of truth, no Zustand mirror.
 * Studio's switcher shares the same core; only the trigger chrome differs.
 * @returns the top-bar language trigger and its locale-selection popover.
 */
export function LangSwitcher(): React.JSX.Element {
  const t = useTranslation();
  const { locale, setLocale, langs } = useLocaleSwitch();
  const current = langFor(locale);
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState<Locale | null>(null);
  const latestPick = React.useRef<Locale | null>(null);

  /**
   * Applies the chosen locale. A language whose strings are not on the page
   * yet keeps its item loading and the popover open until they arrive; only
   * the latest pick's outcome is acted on. When a switch from outside the
   * menu (the account's language at sign-in) took over, the popover closes
   * quietly, since the language has changed.
   * @param code - Locale the user selected from the popover.
   */
  const pick = (code: Locale): void => {
    latestPick.current = code;
    setPending(code);
    void setLocale(code).then((result) => {
      if (latestPick.current !== code) return;
      latestPick.current = null;
      setPending(null);
      if (result === 'failed') {
        toast.error(t('chrome.languageLoadFailed'));
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TopBarTextIconButton
          aria-label={t('chrome.aria.language', { name: current.nativeName })}
          data-testid='lang-trigger'
          icon={<Globe className='h-[18px] w-[18px]' />}
          withChevron
        >
          {current.glyph}
        </TopBarTextIconButton>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-44 p-1'
        data-testid='lang-popover'
      >
        <div className='flex flex-col gap-0.5'>
          {langs.map((l) => (
            <Button
              key={l.code}
              variant='ghost'
              size='menu-item'
              className={cn(
                'justify-start',
                locale === l.code &&
                  'bg-accent-strong hover-enabled:bg-accent-strong',
              )}
              loading={pending === l.code}
              // The glyph is the item's icon, so while its strings download
              // the spinner takes the glyph's column and the row stays put.
              icon={
                <span
                  aria-hidden='true'
                  className='inline-flex h-4 w-4 shrink-0 items-center justify-center text-sm font-medium text-muted-foreground'
                >
                  {l.glyph}
                </span>
              }
              onClick={() => pick(l.code)}
              data-testid={`lang-option-${l.code}`}
            >
              {l.nativeName}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
