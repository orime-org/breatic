import React, { useEffect, useState } from 'react';
import { useUserCenter } from '@/app/store/userCenterStore';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const theme = useUserCenter((s) => s.theme);
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(() => {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  });

  const getSystemTheme = (): 'dark' | 'light' => {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      setSystemTheme(getSystemTheme());
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const actualTheme = theme === 'system' ? systemTheme : theme;

  useEffect(() => {
    const htmlElement = document.documentElement;
    htmlElement.setAttribute('data-theme', actualTheme);
  }, [actualTheme]);

  return <>{children}</>;
};
