// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Keep transient loading failures distinct from resources the server cannot find.
 * @param props - Retry action for the existing resource query.
 * @param props.onRetry - Request the resource again.
 * @returns A localized failure message and retry control.
 * @throws {Error} If React cannot render the error state.
 */
export function ResourceLoadError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const t = useTranslation();
  return (
    <div role='alert' className='flex min-h-[70vh] flex-col items-center justify-center gap-6 px-6 text-center'>
      <p className='text-muted-foreground'>{t('pageLoadError.message')}</p>
      <Button onClick={onRetry}>{t('pageLoadError.retry')}</Button>
    </div>
  );
}
