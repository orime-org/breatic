// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * What the editing surface shows when its page code did not arrive.
 *
 * The one thing known here is that the chunk could not be fetched, so that is
 * what it says. The commonest cause is a deploy the reader's tab has not
 * caught up with — their `index.html` names files from the previous build —
 * but a dropped connection, a blocking extension or a proxy produce the same
 * rejection, and nothing here can tell them apart. Knowing that the server has
 * moved on takes a signal this app does not have yet (todo #252).
 *
 * Refreshing is the reader's to press: nothing reloads the tab on any route
 * (user 2026-09-18, design §7.3). `lazyRoute` renders this in place of the
 * page, so nothing is thrown and the router's own error screen is not
 * involved.
 * @returns The full-viewport notice with a refresh button.
 */
export function PageUnavailableScreen(): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      data-testid='page-unavailable-screen'
      className='flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center'
    >
      <p className='text-sm text-muted-foreground'>{t('common.pageUnavailable.message')}</p>
      <Button
        onClick={() => {
          window.location.reload();
        }}
      >
        {t('common.pageUnavailable.action')}
      </Button>
    </div>
  );
}
