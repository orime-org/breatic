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

interface LeaveProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project's name, quoted in the question. */
  name: string;
  onConfirm: () => void;
  /** True while the leave request is in flight. */
  pending: boolean;
}

/**
 * Confirm before leaving a project: once out, the caller cannot open it
 * again. Shared by the studio card menu and the project page.
 * @param props - Open state, the project name and the confirm callback.
 * @param props.open - Whether the dialog is shown.
 * @param props.onOpenChange - Called when the dialog asks to open or close.
 * @param props.name - The project's name.
 * @param props.onConfirm - Called when the leave is confirmed.
 * @param props.pending - Whether the leave request is in flight.
 * @returns The confirmation dialog.
 */
export function LeaveProjectDialog({
  open,
  onOpenChange,
  name,
  onConfirm,
  pending,
}: LeaveProjectDialogProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid='leave-project-dialog'>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('project.leave.title', { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t('project.leave.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            {t('project.leave.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
