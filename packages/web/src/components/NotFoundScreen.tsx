// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as React from 'react';
import { getLocale } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { getDesktopBridge } from '@web/lib/desktop-bridge';

/**
 * Render the localized missing-page content without changing the requested address.
 * @returns The missing-page message and a link home: the localized home page in a
 * browser, the Studio in the desktop client, whose window keeps only the app's
 * pages and hands the home page to the system browser (inner#2041).
 * @throws {Error} If React cannot render the page.
 */
export function NotFoundScreen(): React.JSX.Element {
  const t = useTranslation();
  const locale = getLocale();
  const home = getDesktopBridge() ? '/studio' : locale === 'en' ? '/' : `/${locale}/`;
  return (
    <div data-testid='not-found-page' className='flex min-h-[70vh] flex-col items-center justify-center px-6 py-24 text-center'>
      <p className='text-8xl font-bold leading-none text-foreground'>404</p>
      <h1 className='mt-4 text-2xl font-semibold tracking-tight'>{t('notFound.heading')}</h1>
      <p className='mt-3 max-w-md text-muted-foreground'>{t('notFound.body')}</p>
      <Button asChild size='form' className='mt-8'>
        <a href={home}>{t('notFound.cta')}</a>
      </Button>
    </div>
  );
}
