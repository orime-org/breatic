// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Monitor, Moon, Sun } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { usePreferencesStore, type ThemeMode } from '@web/stores';
import { TopBarTextIconButton } from '@web/pages/project/chrome/top-bar/TopBarTextIconButton';

/**
 * Theme switcher · TopBar group A (mock § TopBar v4.0).
 *
 * Three modes:
 *   - `light` / `dark` — explicit user choice; CSS `<html data-theme>`
 *     locked to that value
 *   - `system` — follows OS `prefers-color-scheme: dark` via
 *     `matchMedia`; `<html data-theme>` is resolved at runtime and
 *     re-resolved when the OS preference flips
 *
 * The store keeps the intent (`'system'`) separate from the resolved
 * CSS attribute so that re-selecting "System" later still re-follows
 * the OS even if the user had explicitly picked a value in between.
 */
const THEMES: Array<{
  code: ThemeMode;
  label: string;
  icon: typeof Sun;
}> = [
  { code: 'light', label: 'Light', icon: Sun },
  { code: 'dark', label: 'Dark', icon: Moon },
  { code: 'system', label: 'System', icon: Monitor },
];

/**
 * Resolves a theme intent to the concrete light/dark value to apply.
 * @param intent - Stored theme intent; `system` follows the OS color-scheme preference.
 * @returns the concrete `light` or `dark` value to set on `<html data-theme>`.
 */
function resolveTheme(intent: ThemeMode): 'light' | 'dark' {
  if (intent !== 'system') return intent;
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return 'light';
}

/**
 * Theme switcher chrome button with a popover of light/dark/system modes.
 * @returns the top-bar theme trigger and its mode-selection popover.
 */
export function ThemeToggle(): React.JSX.Element {
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = resolveTheme(theme);

    if (theme !== 'system') return;
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    /**
     * Re-resolves `<html data-theme>` when the OS color-scheme preference flips.
     */
    const onChange = (): void => {
      document.documentElement.dataset.theme = mql.matches ? 'dark' : 'light';
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const current = THEMES.find((t) => t.code === theme) ?? THEMES[0];
  const TriggerIcon = current.icon;

  /**
   * Applies the chosen theme mode and closes the popover.
   * @param code - Theme mode the user selected from the popover.
   */
  const pick = (code: ThemeMode): void => {
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
          {THEMES.map((t) => {
            const ItemIcon = t.icon;
            return (
              <Button
                key={t.code}
                variant={theme === t.code ? 'secondary' : 'ghost'}
                size='menu-item'
                className='justify-start'
                onClick={() => pick(t.code)}
                data-testid={`theme-option-${t.code}`}
              >
                <ItemIcon className='h-4 w-4' />
                {t.label}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
