// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';

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
import { ApiException } from '@web/data/api/types';
import { authApi } from '@web/data/api/auth';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';

/** Props for {@link LogoutOthersDialog}. */
interface LogoutOthersDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog asks to open or close. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirm signing this account out of every other device (inner#1548). This
 * device stays signed in; the server ends the other sessions and collab closes
 * what they had open. The confirm button waits on the request; success closes
 * the dialog with a toast, failure keeps it open with a toast.
 * @param props - The open state and its setter.
 * @param props.open - Whether the dialog is open.
 * @param props.onOpenChange - Called when the dialog asks to open or close.
 * @returns The dialog.
 */
export function LogoutOthersDialog({ open, onOpenChange }: LogoutOthersDialogProps): React.JSX.Element {
  const t = useTranslation();
  const logoutOthers = useMutation({
    mutationFn: () => authApi.logoutOthers(),
    onSuccess: () => {
      onOpenChange(false);
      toast.success(t('studio.topBar.logoutOthersDone'));
    },
    onError: (err) => {
      toast.error(err instanceof ApiException ? err.message : t('studio.topBar.logoutOthersFailed'));
    },
  });
  const { mutate, isPending } = logoutOthers;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid='logout-others-dialog'>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('studio.topBar.logoutOthersTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('studio.topBar.logoutOthersBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            loading={isPending}
            onClick={(event) => {
              // Stay open while the request is out; the outcome closes it or
              // leaves it to press again.
              event.preventDefault();
              mutate();
            }}
          >
            {t('studio.topBar.logoutOthers')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
