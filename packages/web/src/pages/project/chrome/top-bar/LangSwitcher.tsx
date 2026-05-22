import { Globe } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { getLocale, type Locale } from '@breatic/shared/i18n';
import { TopBarTextIconButton } from '@/pages/project/chrome/top-bar/TopBarTextIconButton';
import { changeLocale } from '@/i18n/locale-bootstrap';
import { useTranslation } from '@/i18n/use-translation';

/**
 * Language switcher · TopBar group A (mock § TopBar v4.0).
 *
 * Renders the current language single-char glyph inline so the user
 * sees the active locale at a glance (mock: a single char for each
 * locale). Click opens a popover of all 4 supported locales; picking
 * one closes the popover and applies the choice immediately.
 *
 * Wires straight to the shared i18n engine via `changeLocale()`
 * (`@/i18n/locale-bootstrap`):
 *   1. persists the choice to `localStorage["breatic.locale"]`
 *   2. calls `setLocale()` which notifies every `useTranslation`
 *      subscriber so the chrome / chat / drawer surfaces re-render
 *      with the new strings on the same tick.
 *
 * The locale is the single source of truth — no separate Zustand
 * mirror. Reading the current locale uses `useTranslation()` for
 * its `useSyncExternalStore` subscription (so this component
 * re-renders when the locale changes through any code path) and
 * `getLocale()` to read the current value.
 */
type LangSlug = 'en' | 'zhCN' | 'zhTW' | 'ja';

const LANGS: Array<{ code: Locale; slug: LangSlug }> = [
  { code: 'zh-CN', slug: 'zhCN' },
  { code: 'en', slug: 'en' },
  { code: 'ja', slug: 'ja' },
  { code: 'zh-TW', slug: 'zhTW' },
];

function slugFor(code: Locale): LangSlug {
  return LANGS.find((l) => l.code === code)?.slug ?? 'en';
}

export function LangSwitcher() {
  const t = useTranslation();
  const language = getLocale();
  const currentSlug = slugFor(language);
  const [open, setOpen] = React.useState(false);

  const pick = (code: Locale) => {
    changeLocale(code);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TopBarTextIconButton
          aria-label={`Language: ${t(`lang.${currentSlug}.label`)}`}
          data-testid='lang-trigger'
          icon={<Globe className='h-[18px] w-[18px]' />}
          withChevron
        >
          {t(`lang.${currentSlug}.glyph`)}
        </TopBarTextIconButton>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-40 p-1'
        data-testid='lang-popover'
      >
        <div className='flex flex-col gap-0.5'>
          {LANGS.map((l) => (
            <Button
              key={l.code}
              variant={language === l.code ? 'secondary' : 'ghost'}
              size='menu-item'
              className='justify-start'
              onClick={() => pick(l.code)}
              data-testid={`lang-option-${l.code}`}
            >
              <span
                aria-hidden='true'
                className='inline-flex w-4 shrink-0 justify-center text-[13px] font-medium text-muted-foreground'
              >
                {t(`lang.${l.slug}.glyph`)}
              </span>
              {t(`lang.${l.slug}.label`)}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
