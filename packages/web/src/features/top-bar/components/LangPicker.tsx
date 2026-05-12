/**
 * LangPicker — small dropdown for switching the i18n language. Mock
 * 05 @1108 sits between the members popover and the theme picker.
 *
 * Drives `useUserCenterStore.setLanguage` (which persists to
 * localStorage) AND `i18next.changeLanguage` so the UI re-renders
 * with the new locale immediately.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import i18n from '@/i18n';
import { useUserCenterStore } from '@/app/hooks/useUserCenterStore';

const LANGUAGE_OPTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'en',    label: 'English' },
  { key: 'zh-CN', label: '简体中文' },
  { key: 'zh-TW', label: '繁體中文' },
  { key: 'ja',    label: '日本語' },
];

const SHORT_LABEL: Record<string, string> = {
  en:      'EN',
  'zh-CN': '中',
  'zh-TW': '繁',
  ja:      '日',
};

const GlobeGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0 -18" />
  </svg>
);

const LangPicker: React.FC = memo(function LangPicker() {
  const { t } = useTranslation();
  const { language, setLanguage } = useUserCenterStore();

  const items: MenuItemType[] = LANGUAGE_OPTIONS.map(({ key, label }) => ({
    key,
    label,
  }));

  const handleClick = (key: string) => {
    setLanguage(key);
    i18n.changeLanguage(key);
  };

  return (
    <Dropdown
      items={items}
      onClick={handleClick}
      selectedKeys={[language]}
      trigger='click'
      placement='bottom-end'
    >
      <button
        type='button'
        title={t('project.header.language', { defaultValue: 'Language' })}
        className='inline-flex items-center gap-1 h-8 px-2 rounded-sm text-[12px] text-text-default-secondary hover:bg-background-default-secondary hover:text-text-default-base transition-colors'
      >
        <GlobeGlyph />
        <span>{SHORT_LABEL[language] ?? 'EN'}</span>
      </button>
    </Dropdown>
  );
});

export default LangPicker;
