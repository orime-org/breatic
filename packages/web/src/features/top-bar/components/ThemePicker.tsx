/**
 * ThemePicker — dropdown to toggle light / dark / system theme. Mock
 * 05 @1109 sits between LangPicker and CreditsPill.
 *
 * Persists through `useUserCenterStore.setTheme` (writes to
 * `localStorage.theme`). The `ThemeProvider` reads the store and
 * resolves `'system'` against `prefers-color-scheme` for the actual
 * `data-theme` attribute.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import { useUserCenterStore } from '@/app/hooks/useUserCenterStore';

type ThemeMode = 'light' | 'dark' | 'system';

const SunGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const MoonGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const MonitorGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
    <rect x="2" y="4" width="20" height="14" rx="2" />
    <path d="M8 22h8M12 18v4" />
  </svg>
);

const ThemePicker: React.FC = memo(function ThemePicker() {
  const { t } = useTranslation();
  const { theme, setTheme } = useUserCenterStore();
  const current: ThemeMode = theme === 'light' || theme === 'dark' || theme === 'system'
    ? theme
    : 'system';

  const items: MenuItemType[] = [
    { key: 'light',  label: t('project.header.lightMode',  { defaultValue: 'Light' }) },
    { key: 'dark',   label: t('project.header.darkMode',   { defaultValue: 'Dark' }) },
    { key: 'system', label: t('project.header.monitor',    { defaultValue: 'System' }) },
  ];

  const handleClick = (key: string) => {
    if (key === 'light' || key === 'dark' || key === 'system') {
      setTheme(key);
    }
  };

  const TriggerGlyph =
    current === 'light' ? SunGlyph : current === 'dark' ? MoonGlyph : MonitorGlyph;

  return (
    <Dropdown
      items={items}
      onClick={handleClick}
      selectedKeys={[current]}
      trigger='click'
      placement='bottom-end'
    >
      <button
        type='button'
        title={t('project.header.theme', { defaultValue: 'Theme' })}
        className='inline-flex items-center justify-center w-8 h-8 rounded-sm text-text-default-secondary hover:bg-background-default-secondary hover:text-text-default-base transition-colors'
      >
        <TriggerGlyph />
      </button>
    </Dropdown>
  );
});

export default ThemePicker;
