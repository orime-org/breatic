// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * The main area while the open Studio's or Project's region cannot be
 * reached. The Studio page keeps its top bar and rail around it; the Project
 * page has neither, so it also links back home.
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
      <div className='mt-3 flex gap-2'>
        {kind === 'project' ? (
          <Button asChild variant='outline'>
            <Link to='/studio'>{t('notFound.cta')}</Link>
          </Button>
        ) : null}
        <Button onClick={onRetry}>{t('pageLoadError.retry')}</Button>
      </div>
    </div>
  );
}
