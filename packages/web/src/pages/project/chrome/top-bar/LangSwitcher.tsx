import { Globe } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { getLocale, type Locale } from '@breatic/shared';
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

/**
 * Each entry uses its **own** native name + glyph — the popover must
 * read correctly to a user who only speaks that language. Translating
 * "Japanese" → 日本語 only when the active locale is ja defeats the
 * purpose: a Chinese-only user with the UI in en would see "Japanese"
 * and not know which option matches their preference.
 *
 * `nativeName` is intentionally hardcoded (not in locale JSON) so it
 * is identical regardless of active locale.
 */
const LANGS: Array<{
  code: Locale;
  slug: LangSlug;
  glyph: string;
  nativeName: string;
}> = [
  { code: 'zh-CN', slug: 'zhCN', glyph: '中', nativeName: '简体中文' },
  { code: 'en', slug: 'en', glyph: 'EN', nativeName: 'English' },
  { code: 'ja', slug: 'ja', glyph: '日', nativeName: '日本語' },
  { code: 'zh-TW', slug: 'zhTW', glyph: '繁', nativeName: '繁體中文' },
];

function langFor(code: Locale): (typeof LANGS)[number] {
  return LANGS.find((l) => l.code === code) ?? LANGS[1];
}

export function LangSwitcher() {
  useTranslation(); // subscribe so the trigger glyph re-renders on locale change
  const language = getLocale();
  const current = langFor(language);
  const [open, setOpen] = React.useState(false);

  const pick = (code: Locale) => {
    changeLocale(code);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TopBarTextIconButton
          aria-label={`Language: ${current.nativeName}`}
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
                {l.glyph}
              </span>
              {l.nativeName}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
