// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * The main area while the open Studio's or Project's region cannot be
 * reached; the top bar and switcher stay usable around it.
 * @param root0 - Props.
 * @param root0.kind - Whether a Studio or a Project is open.
 * @param root0.onRetry - Ask again; a success opens the page.
 * @returns The state.
 */
export function RegionUnavailable({ kind, onRetry }: { kind: 'studio' | 'project'; onRetry: () => void }): React.JSX.Element {
  const t = useTranslation();
  return (
    <div role='alert' className='flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center'>
      <p className='text-base font-medium text-foreground'>
        {t(kind === 'studio' ? 'regions.unavailable.studioTitle' : 'regions.unavailable.projectTitle')}
      </p>
      <p className='max-w-md text-sm text-muted-foreground'>{t('regions.unavailable.body')}</p>
      <Button className='mt-3' onClick={onRetry}>{t('pageLoadError.retry')}</Button>
    </div>
  );
}
