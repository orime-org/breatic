// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@web/components/ui/alert-dialog';
import { Button } from '@web/components/ui/button';
import { useStaleRelease } from '@web/data/deployment/stale-release';
import { useAppUpdate } from '@web/data/deployment/use-app-update';
import type { ConnectionStatus } from '@web/data/yjs/use-socket';
import { useTranslation } from '@web/i18n/use-translation';
import { reloadForUpdate } from '@web/stores/reload-for-update';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

/**
 * A new release, offered while this page still works: the dialog opens by
 * itself once per release, and the top-bar notice stays until the page
 * reloads. Connection errors take precedence, and the forced dialog of an
 * out-of-date page replaces it.
 * @param props - The notice's inputs.
 * @param props.status - The collaboration connection's state.
 * @returns The notice, or nothing when there is no release to offer.
 */
export const ProjectUpdateNotice = React.memo(function ProjectUpdateNotice({
  status,
}: { status: ConnectionStatus }): React.JSX.Element | null {
  const { version, autoOpen, dismiss } = useAppUpdate();
  const stale = useStaleRelease();
  if (!version || stale || status === 'disconnected' || status === 'authFailed') return null;
  return <UpdateNotice key={version} autoOpen={autoOpen} onPostpone={dismiss} />;
});

/**
 * The top-bar notice and the dialog it opens, for one release.
 * @param props - The notice's inputs.
 * @param props.autoOpen - Open the dialog on mount; false for a postponed release.
 * @param props.onPostpone - Stop opening this release by itself in this tab.
 * @returns The notice and its dialog.
 */
function UpdateNotice({
  autoOpen,
  onPostpone,
}: { autoOpen: boolean; onPostpone: () => void }): React.JSX.Element {
  const t = useTranslation();
  const busy = useSpaceOperationsStore((state) => state.hasAnyOperations());
  const [open, setOpen] = React.useState(autoOpen);
  const onOpenChange = React.useCallback((next: boolean): void => {
    // Closing is Later or Escape; Update keeps the dialog open.
    if (!next) onPostpone();
    setOpen(next);
  }, [onPostpone]);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant='outline' size='sm' className='shrink-0 gap-1.5' data-testid='project-update-trigger'>
          <span className='size-1.5 rounded-full bg-status-info' aria-hidden />
          {t('project.update.available')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('project.update.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(busy ? 'project.update.busy' : 'project.update.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('project.update.later')}</AlertDialogCancel>
          <AlertDialogAction
            data-testid='project-update-refresh'
            onClick={(event) => {
              // Held open: the leave prompt may be cancelled, and the choice
              // has to still be in reach when it is.
              event.preventDefault();
              reloadForUpdate();
            }}
          >
            {t('project.update.refresh')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
