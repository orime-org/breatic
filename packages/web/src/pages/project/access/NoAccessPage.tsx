// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Full-screen "you don't have access to this project" page.
 *
 * Per 2026-05-28 spec § 2 — when a non-member directly opens a
 * project URL we surface a friendly screen telling them to contact
 * the project owner. We do **not** reveal the owner's email address
 * (so anyone with a projectId can't spam the owner). The page also
 * offers a button to go back to /studio.
 *
 * This page replaces the old AccessRequestPage which assumed the
 * pre-spec "request to join + owner approves" flow; that flow was
 * cut on 2026-05-28 in favour of "link = direct access" semantics.
 * @returns The full-screen no-access notice with a link back to Studio.
 */
export default function NoAccessPage(): React.JSX.Element {
  const t = useTranslation();
  return (
    <main
      data-testid='no-access-page'
      className='flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center'
    >
      <div className='flex flex-col items-center gap-3'>
        <h1 className='text-2xl font-semibold text-foreground'>
          {t('noAccess.title')}
        </h1>
        <p className='max-w-md text-base text-muted-foreground'>
          {t('noAccess.description')}
        </p>
      </div>
      <Button asChild size='form'>
        <Link to='/studio'>{t('noAccess.backToStudio')}</Link>
      </Button>
    </main>
  );
}
