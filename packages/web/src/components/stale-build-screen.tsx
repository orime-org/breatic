// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * What a route shows when its page is no longer on the server.
 *
 * A reader who keeps a tab open across a deploy holds an `index.html` naming
 * chunks from the previous build, and those files are gone. That is a screen
 * the reader can always get out of — refreshing fetches the new document,
 * whose names resolve — so this says so and hands them the button, rather
 * than the app refreshing on its own behind their back (user 2026-09-18;
 * design §7.3). Everything they already have stays usable: only the entry
 * whose chunk is missing stops here.
 *
 * `lazyRoute` renders this in place of the page, so nothing is thrown and the
 * router's own error screen is not involved.
 * @returns The full-viewport notice with a refresh button.
 */
export function StaleBuildScreen(): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      data-testid='stale-build-screen'
      className='flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center'
    >
      <p className='text-sm text-muted-foreground'>{t('common.staleBuild.message')}</p>
      <Button
        onClick={() => {
          window.location.reload();
        }}
      >
        {t('common.staleBuild.action')}
      </Button>
    </div>
  );
}
