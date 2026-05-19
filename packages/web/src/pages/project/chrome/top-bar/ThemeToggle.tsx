import { Moon, Sun } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { usePreferencesStore, type ThemeMode } from '@/stores';
import { TopBarTextIconButton } from './TopBarTextIconButton';

/**
 * Theme switcher · TopBar group A (mock § TopBar v4.0).
 *
 * Renders the current theme's icon (sun for light, moon for dark) + a
 * chevron-down to indicate it opens a popover. The popover lists the
 * available themes. Theme write reflects on `<html data-theme>` so the
 * token palette flips synchronously across the app.
 *
 * System-mode follow-up: when prefs adds 'system', this becomes a
 * 3-option popover.
 */
const THEMES: Array<{ code: ThemeMode; label: string }> = [
  { code: 'light', label: 'Light' },
  { code: 'dark', label: 'Dark' },
];

export function ThemeToggle() {
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const Icon = theme === 'light' ? Sun : Moon;

  const pick = (code: ThemeMode) => {
    setTheme(code);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TopBarTextIconButton
          aria-label={`Theme: ${theme}`}
          data-testid='theme-toggle'
          icon={<Icon className='h-[18px] w-[18px]' />}
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
          {THEMES.map((t) => (
            <Button
              key={t.code}
              variant={theme === t.code ? 'secondary' : 'ghost'}
              size='sm'
              className='justify-start'
              onClick={() => pick(t.code)}
              data-testid={`theme-option-${t.code}`}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
