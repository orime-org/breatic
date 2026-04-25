import React, { memo, useEffect } from 'react';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import { Icon } from '@/components/base/icon';
import '@/apps/project/components/agent/ProjectHeader.css';

type ThemeMode = 'system' | 'dark' | 'light';

/**
 * Theme Switcher Component
 * @description Sliding selector for theme mode (system/dark/light)
 * Style reference: ProjectHeader.tsx top menu icons
 */
const ThemeSwitcher: React.FC = () => {
  const { theme, setTheme } = useUserCenterStore();

  // Load theme from localStorage on mount.
  useEffect(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setTheme(stored);
    } else {
      // Default to system when missing.
      setTheme('system');
    }
  }, [setTheme]);

  // Resolve theme mode from current state.
  const getThemeMode = (): 'system' | 'dark' | 'light' => {
    if (theme === 'system') {
      return 'system';
    } else if (theme === 'dark' || theme === 'light') {
      return theme;
    }
    return 'system';
  };

  const themeMode = getThemeMode();

  const themeOptions = [
    { mode: 'system' as ThemeMode, iconName: 'project-monitor-icon' },
    { mode: 'dark' as ThemeMode, iconName: 'project-moon-icon' },
    { mode: 'light' as ThemeMode, iconName: 'project-sun-icon' },
  ];

  return (
    <div className='flex items-center justify-center gap-2 bg-background-default-secondary rounded-full h-[32px]'>
      {themeOptions.map((option) => {
        const isSelected = themeMode === option.mode;
        return (
          <div
            key={option.mode}
            className={`cursor-pointer rounded-2xl flex items-center justify-center w-9 h-7 p-0 ${
              isSelected
                ? 'bg-background-default-base shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05)] shadow-[0px_1px_8px_1px_rgba(12,12,13,0.05)]'
                : 'hover:bg-background-default-base hover:shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05)] hover:shadow-[0px_1px_8px_1px_rgba(12,12,13,0.05)]'
            }`}
            onClick={() => setTheme(option.mode)}
            title={option.mode === 'system' ? 'System' : option.mode === 'dark' ? 'Dark' : 'Light'}
          >
            <Icon
              name={option.iconName}
              width={20}
              height={18}
              color='var(--color-icon-secondary-hover)'
            />
          </div>
        );
      })}
    </div>
  );
};

export default memo(ThemeSwitcher);
