// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { useStaleRelease } from '@web/data/deployment/stale-release';
import { useTranslation } from '@web/i18n/use-translation';
import { reloadForUpdate } from '@web/stores/reload-for-update';

/**
 * The page is too old to keep working: a request it sent was refused for its
 * shape and a newer build is live. Update is the only way on; Escape and the
 * backdrop do not close it.
 * @returns The dialog, open once the page is found out of date.
 */
export function StaleReleaseDialog(): React.JSX.Element | null {
  const t = useTranslation();
  const stale = useStaleRelease();
  if (!stale) return null;
  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('app.staleRelease.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('app.staleRelease.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            data-testid='stale-release-refresh'
            onClick={(event) => {
              // Held open: the leave prompt may be cancelled.
              event.preventDefault();
              reloadForUpdate();
            }}
          >
            {t('app.staleRelease.refresh')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
