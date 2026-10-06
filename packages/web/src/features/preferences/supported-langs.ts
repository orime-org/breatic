// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { getLocale, t, type Locale } from '@breatic/shared';

import { usersApi } from '@web/data/api/users';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';
import { useCurrentUserStore } from '@web/stores/current-user';

export interface SupportedLang {
  code: Locale;
  glyph: string;
  nativeName: string;
}

/**
 * The locales every language switcher offers (project + studio share
 * this list). Each `nativeName` is written in its own script so the
 * option reads correctly to a speaker of that language regardless of
 * the active UI locale; these are constant product data, intentionally
 * NOT localized (hence this file's entry in the no-cjk check's allowlist).
 */
export const SUPPORTED_LANGS: SupportedLang[] = [
  { code: 'en', glyph: 'EN', nativeName: 'English' },
  { code: 'zh-CN', glyph: '中', nativeName: '简体中文' },
  { code: 'zh-TW', glyph: '繁', nativeName: '繁體中文' },
  { code: 'ja', glyph: '日', nativeName: '日本語' },
  { code: 'ko', glyph: '한', nativeName: '한국어' },
];

/**
 * Resolve the language descriptor for a locale, falling back to English.
 * @param code - Active locale to look up.
 * @returns the matching language entry, or the English entry when none matches.
 */
export function langFor(code: Locale): SupportedLang {
  return (
    SUPPORTED_LANGS.find((l) => l.code === code) ??
    SUPPORTED_LANGS.find((l) => l.code === 'en') ??
    SUPPORTED_LANGS[0]
  );
}

export interface UseLocaleSwitch {
  locale: Locale;
  setLocale: (code: Locale) => void;
  langs: SupportedLang[];
}

/**
 * Switch the interface language and, when someone is signed in, record it on
 * the account. The interface switches at once and the choice is kept on this
 * device; the account write runs behind it, and when it fails the reader is
 * told the choice was not saved to the account. A visitor on a sign-in page
 * has no account to write to, so their choice stays on the device only.
 * @param code - The locale the reader picked.
 */
function switchLocale(code: Locale): void {
  changeLocale(code);
  if (useCurrentUserStore.getState().user === null) return;
  usersApi.setLocale(code).catch(() => {
    toast.error(t('chrome.languageNotSaved'));
  });
}

/**
 * Shared locale-switch hook used by every language switcher (project +
 * studio). The i18n engine is the single source of truth — there is no
 * Zustand mirror (see `feedback_double_source_state_mirror_trap`).
 * Subscribes via `useTranslation()` so the caller re-renders when the
 * locale changes through any code path.
 * @returns the active locale, a setter, and the selectable locale list.
 */
export function useLocaleSwitch(): UseLocaleSwitch {
  useTranslation(); // subscribe so the trigger re-renders on locale change
  return {
    locale: getLocale(),
    setLocale: switchLocale,
    langs: SUPPORTED_LANGS,
  };
}
