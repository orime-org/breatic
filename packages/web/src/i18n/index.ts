import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import unified locale files from monorepo root (via @locales alias)
import en from '@locales/en.json';
import ja from '@locales/ja.json';
import zhCN from '@locales/zh-CN.json';
import zhTW from '@locales/zh-TW.json';

/**
 * Central i18next setup.
 *
 * Unified locale files at /locales/*.json are shared between
 * frontend and backend. Vite imports them at build time via
 * the @locales alias configured in vite.config.ts.
 */
const resources = {
  en: { common: en },
  ja: { common: ja },
  'zh-CN': { common: zhCN },
  'zh-TW': { common: zhTW },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'language',
      caches: ['localStorage'],
      convertDetectedLanguage: (lng: string) => {
        const languageMap: Record<string, string> = {
          'en': 'en',
          'en-US': 'en',
          'ja': 'ja',
          'ja-JP': 'ja',
          'zh': 'zh-CN',
          'zh-CN': 'zh-CN',
          'zh-TW': 'zh-TW',
          'zh-HK': 'zh-TW',
        };
        return languageMap[lng] || 'en';
      },
    },
    fallbackLng: 'en',
    defaultNS: 'common',
    debug: false,
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
