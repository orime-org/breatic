// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Reload the complete document so a failed or externally mutated tree is discarded.
 * @throws {Error} If the browser refuses navigation.
 */
function reloadPage(): void {
  window.location.reload();
}

/**
 * Render recovery independently of the router, authentication and query providers.
 * @param props - Optional monitoring event identifier; never an error message.
 * @param props.eventId - Identifier returned by a configured monitoring client.
 * @returns A localized recovery page without exception text or application data.
 * @throws {Error} If React cannot render the recovery page.
 */
export function ApplicationErrorPage({ eventId }: { eventId?: string }): React.JSX.Element {
  const t = useTranslation();
  return (
    <main translate='no' className='flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center text-foreground'>
      <div className='flex max-w-md flex-col gap-3'>
        <h1 className='text-xl font-semibold'>{t('applicationError.title')}</h1>
        <p className='text-sm text-muted-foreground'>{t('applicationError.message')}</p>
      </div>
      <div className='flex flex-wrap justify-center gap-3'>
        <Button variant='outline' onClick={reloadPage}>{t('applicationError.reload')}</Button>
        <Button variant='outline' asChild><a href='/'>{t('applicationError.home')}</a></Button>
      </div>
      {eventId ? <p className='break-all text-xs text-muted-foreground'>{t('applicationError.reference', { id: eventId })}</p> : null}
    </main>
  );
}
