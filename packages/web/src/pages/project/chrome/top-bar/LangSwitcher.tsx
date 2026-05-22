import { Globe } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { usePreferencesStore, type Language } from '@/stores';
import { TopBarTextIconButton } from '@/pages/project/chrome/top-bar/TopBarTextIconButton';
import { useTranslation } from '@/i18n/use-translation';

/**
 * Language switcher · TopBar group A (mock § TopBar v4.0).
 *
 * Renders the current language single-char label inline so the user
 * sees the active locale at a glance (mock: a single char for each
 * locale). Click opens a popover of all 4 supported locales; picking
 * one closes the popover.
 *
 * The actual i18n translation provider is wired in a later PR.
 */
type LangSlug = 'en' | 'zhCN' | 'zhTW' | 'ja';

const LANGS: Array<{ code: Language; slug: LangSlug }> = [
  { code: 'zh-CN', slug: 'zhCN' },
  { code: 'en', slug: 'en' },
  { code: 'ja', slug: 'ja' },
  { code: 'zh-TW', slug: 'zhTW' },
];

export function LangSwitcher() {
  const t = useTranslation();
  const language = usePreferencesStore((s) => s.language);
  const setLanguage = usePreferencesStore((s) => s.setLanguage);
  const current = LANGS.find((l) => l.code === language) ?? LANGS[0];
  const [open, setOpen] = React.useState(false);

  const pick = (code: Language) => {
    setLanguage(code);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TopBarTextIconButton
          aria-label={`Language: ${t(`lang.${current.slug}.label`)}`}
          data-testid='lang-trigger'
          icon={<Globe className='h-[18px] w-[18px]' />}
          withChevron
        >
          {t(`lang.${current.slug}.glyph`)}
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
