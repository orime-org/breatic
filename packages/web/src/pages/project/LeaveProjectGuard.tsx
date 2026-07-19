// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useBlocker, type Location } from 'react-router-dom';

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
import { useSpaceOperationsStore } from '@web/stores/space-operations';

/**
 * Whether an in-app navigation away from the project must be confirmed first:
 * only when a FRONT-END operation is in flight AND the target route is a
 * different page. Backend AIGC is intentionally excluded (its write-back rides
 * the server-side collab doc and survives leaving), which is exactly what
 * `useSpaceOperationsStore` already tracks. A same-pathname change (never
 * happens on the project route today) is not "leaving".
 * @param hasFrontEndOps - Whether any space has an in-flight front-end op.
 * @param currentPath - The current location pathname.
 * @param nextPath - The pathname being navigated to.
 * @returns True when the leave must be confirmed.
 */
export function shouldBlockLeave(
  hasFrontEndOps: boolean,
  currentPath: string,
  nextPath: string,
): boolean {
  return hasFrontEndOps && currentPath !== nextPath;
}

/**
 * Confirm before leaving a project (in-app navigation — the top-bar "Studio"
 * back link, the logo, browser back) while a front-end operation is still in
 * flight, mirroring the `beforeunload` guard that already covers tab close /
 * reload (#1617). Uses the router's `useBlocker` so ONE guard covers every
 * leave path instead of patching each link. Confirming proceeds; cancelling (or
 * Escape) stays. Renders nothing while not blocked.
 * @returns The confirmation dialog (open only while a leave is blocked).
 */
export function LeaveProjectGuard(): React.JSX.Element {
  const t = useTranslation();
  const blocker = useBlocker(
    React.useCallback(
      ({
        currentLocation,
        nextLocation,
      }: {
        currentLocation: Location;
        nextLocation: Location;
      }) =>
        shouldBlockLeave(
          useSpaceOperationsStore.getState().hasAnyOperations(),
          currentLocation.pathname,
          nextLocation.pathname,
        ),
      [],
    ),
  );
  const blocked = blocker.state === 'blocked';
  // Set right before `proceed()` so the dialog's own close event (Radix fires
  // onOpenChange(false) when Action closes it) does not race a `reset()` that
  // would cancel the navigation we just allowed.
  const proceedingRef = React.useRef(false);

  return (
    <AlertDialog
      open={blocked}
      onOpenChange={(open) => {
        if (open) return;
        if (proceedingRef.current) {
          proceedingRef.current = false;
          return;
        }
        if (blocker.state === 'blocked') blocker.reset();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('project.leaveGuard.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('project.leaveGuard.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('project.leaveGuard.stay')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              proceedingRef.current = true;
              if (blocker.state === 'blocked') blocker.proceed();
            }}
          >
            {t('project.leaveGuard.leave')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
