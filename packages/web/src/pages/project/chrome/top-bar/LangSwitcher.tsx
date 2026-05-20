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

/**
 * Language switcher · TopBar group A (mock § TopBar v4.0).
 *
 * Renders the current language single-char label inline so the user
 * sees the active locale at a glance (mock: "中" for zh-CN). Click opens
 * a popover of all 4 supported locales; picking one closes the popover.
 *
 * The actual i18n translation provider is wired in a later PR.
 */
const LANGS: Array<{ code: Language; label: string; char: string }> = [
  { code: 'zh-CN', label: '简体中文', char: '中' },
  { code: 'en', label: 'English', char: 'EN' },
  { code: 'ja', label: '日本語', char: '日' },
  { code: 'zh-TW', label: '繁體中文', char: '繁' },
];

export function LangSwitcher() {
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
          aria-label={`Language: ${current.label}`}
          data-testid='lang-trigger'
          icon={<Globe className='h-[18px] w-[18px]' />}
          withChevron
        >
          {current.char}
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
              size='sm'
              className='justify-start'
              onClick={() => pick(l.code)}
              data-testid={`lang-option-${l.code}`}
            >
              {l.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
