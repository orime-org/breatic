import { Moon, Sun } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { usePreferencesStore } from '@/stores';

/**
 * Theme toggle — light ↔ dark. Reads from the preferences store and
 * mirrors the value onto `<html data-theme>` so the token bridge layer
 * (shadcn-bridge.css + tokens.css) flips palettes synchronously.
 */
export function ThemeToggle() {
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <Button
      variant='ghost'
      size='icon'
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
      data-testid='theme-toggle'
    >
      {theme === 'light' ? (
        <Sun className='h-4 w-4' />
      ) : (
        <Moon className='h-4 w-4' />
      )}
    </Button>
  );
}
