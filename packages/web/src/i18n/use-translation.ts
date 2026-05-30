import * as React from 'react';
import {
  getLocale,
  onLocaleChange,
  t as sharedT,
  type Locale,
} from '@breatic/shared';

/**
 * React hook over the shared `t()` engine. Returns the `t` function
 * itself; subscribing components re-render automatically when the
 * active locale changes (via `setLocale()` or `changeLocale()`).
 *
 * Usage:
 *
 *   const t = useTranslation();
 *   return <button>{t('project.chrome.tabBar.newSpace.submit')}</button>;
 *
 * Or with ICU parameters:
 *
 *   t('cart.items', { count: 5 })
 *
 * Per the i18n-migration DD (rev 3), the hook keeps the shared `t()` external API
 * unchanged — components don't import `useTranslation` to get a
 * *different* `t`, they import it to get one whose call site
 * subscribes to locale-change events for re-render.
 */
export function useTranslation(): typeof sharedT {
  // Subscribe via React 18 `useSyncExternalStore` so the hook is
  // concurrent-mode safe and the component re-renders on locale change.
  React.useSyncExternalStore(
    subscribeToLocale,
    getLocaleSnapshot,
    getLocaleSnapshot,
  );
  return sharedT;
}

function subscribeToLocale(onChange: () => void): () => void {
  return onLocaleChange(() => onChange());
}

function getLocaleSnapshot(): Locale {
  return getLocale();
}
