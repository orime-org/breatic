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
} from '@web/components/ui/alert-dialog';
import { useTranslation } from '@web/i18n/use-translation';

interface ArchiveProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project's name, quoted in the question. */
  name: string;
  onConfirm: () => void;
}

/**
 * Confirm before archiving: archiving disconnects whoever is editing, so it is
 * asked once rather than done on the menu click.
 * @param props - Open state, the project name and the confirm callback.
 * @param props.open - Whether the dialog is shown.
 * @param props.onOpenChange - Called when the dialog asks to open or close.
 * @param props.name - The project's name.
 * @param props.onConfirm - Called when the archive is confirmed.
 * @returns The confirmation dialog.
 */
export function ArchiveProjectDialog({
  open,
  onOpenChange,
  name,
  onConfirm,
}: ArchiveProjectDialogProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid='archive-project-dialog'>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('studio.container.card.archiveTitle', { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t('studio.container.card.archiveBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('studio.container.card.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('studio.container.card.archive')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
