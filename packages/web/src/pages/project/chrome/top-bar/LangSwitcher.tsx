import { Globe } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { usePreferencesStore, type Language } from '@/stores';

const LANGS: Array<{ code: Language; label: string }> = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh-TW', label: '繁體中文' },
];

/**
 * Language switcher — popover list bound to the preferences store. The
 * actual i18n provider that translates `language` → React content runs
 * in `app/providers/I18nProvider` (PR for i18n).
 */
export function LangSwitcher() {
  const language = usePreferencesStore((s) => s.language);
  const setLanguage = usePreferencesStore((s) => s.setLanguage);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant='ghost' size='icon' aria-label='Language'>
          <Globe className='h-4 w-4' />
        </Button>
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
              onClick={() => setLanguage(l.code)}
            >
              {l.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
