// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as React from 'react';
import { ArrowLeft, Copy } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * What the Project page shows for a copy still being copied (inner#1706): that it is being copied and a way back to
 * Studio, whose card for it opens once the copy is done.
 * @returns The notice.
 */
export function ProjectCopyingScreen(): React.JSX.Element {
  const t = useTranslation();
  return (
    <div data-testid='project-copying' className='flex min-h-[70vh] items-center justify-center px-6 py-24'>
      <div className='flex max-w-sm flex-col items-center gap-3 rounded-chrome border border-border bg-card px-6 py-5 text-center'>
        {/* A still icon: this page does not refresh itself; the user opens the copy from Studio. */}
        <Copy className='size-6 text-muted-foreground' aria-hidden />
        <p className='text-balance text-sm text-foreground'>{t('project.copying.title')}</p>
        <Button asChild variant='outline' size='sm' className='mt-1'>
          <Link to='/studio'>
            <ArrowLeft className='mr-1.5 size-3.5' aria-hidden />
            {t('project.copying.backToStudio')}
          </Link>
        </Button>
      </div>
    </div>
  );
}
