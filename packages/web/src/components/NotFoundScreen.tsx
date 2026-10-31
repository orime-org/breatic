// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { getLocale } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Render the localized missing-page content without changing the requested address.
 * @returns The missing-page message and a link to the localized home page.
 * @throws {Error} If React cannot render the page.
 */
export function NotFoundScreen(): React.JSX.Element {
  const t = useTranslation();
  const locale = getLocale();
  return (
    <div data-testid='not-found-page' className='flex min-h-[70vh] flex-col items-center justify-center px-6 py-24 text-center'>
      <p className='text-8xl font-bold leading-none text-foreground'>404</p>
      <h1 className='mt-4 text-2xl font-semibold tracking-tight'>{t('notFound.heading')}</h1>
      <p className='mt-3 max-w-md text-muted-foreground'>{t('notFound.body')}</p>
      <Button asChild size='form' className='mt-8'>
        <a href={locale === 'en' ? '/' : `/${locale}/`}>{t('notFound.cta')}</a>
      </Button>
    </div>
  );
}
