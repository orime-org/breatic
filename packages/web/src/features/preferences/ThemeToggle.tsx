// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';
import { useThemeMode } from '@web/features/preferences/theme-mode';
import { useTranslation } from '@web/i18n/use-translation';
import { TopBarTextIconButton } from '@web/features/preferences/TopBarTextIconButton';

/**
 * Theme switcher · TopBar group A (mock § TopBar v4.0).
 *
 * Three modes (light / dark / system) come from the shared
 * `useThemeMode()` core (`@web/features/preferences/theme-mode`), which
 * also mirrors the resolved value onto `<html data-theme>` and re-follows
 * the OS preference for `system`. Studio's switcher shares the same core
 * — only the trigger chrome differs.
 * @returns the top-bar theme trigger and its mode-selection popover.
 */
export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme, modes } = useThemeMode();
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);

  const current = modes.find((m) => m.code === theme) ?? modes[0];
  const TriggerIcon = current.icon;

  /**
   * Applies the chosen theme mode and closes the popover.
   * @param code - Theme mode the user selected from the popover.
   */
  const pick = (code: typeof theme): void => {
    setTheme(code);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TopBarTextIconButton
          aria-label={`Theme: ${theme}`}
          data-testid='theme-toggle'
          icon={<TriggerIcon className='h-[18px] w-[18px]' />}
          withChevron
        >
          {/* Mock shows only the icon + chevron — pass an empty label-equivalent space */}
          <span className='sr-only'>{theme}</span>
        </TopBarTextIconButton>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-40 p-1'
        data-testid='theme-popover'
      >
        <div className='flex flex-col gap-0.5'>
          {modes.map((m) => {
            const ItemIcon = m.icon;
            return (
              <Button
                key={m.code}
                variant='ghost'
                size='menu-item'
                className={cn('justify-start', theme === m.code && 'bg-accent')}
                onClick={() => pick(m.code)}
                data-testid={`theme-option-${m.code}`}
              >
                <ItemIcon className='h-4 w-4' />
                {t(m.i18nKey)}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
