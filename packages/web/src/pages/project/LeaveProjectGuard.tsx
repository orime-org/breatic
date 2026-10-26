// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { NavigationType, useBlocker, useParams, type Location } from 'react-router-dom';

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
import { hasProjectUnsyncedEdits, useProjectUnsyncedEdits } from '@web/data/yjs/collab-socket';
import { projectUuidFromRouteParam } from '@web/lib/project-route';
import { useReturnFocus } from '@web/lib/overlay-focus';
import { toast } from '@web/lib/toast';

/** Page-owned access to the same confirmation used for route and browser leaves. */
export interface LeaveProjectGuardHandle {
  requestRefresh: () => void;
}

/**
 * Requires confirmation when pending work would be left by a route change.
 * @param hasPendingWork - Unsynced local content or an in-flight front-end operation.
 * @param currentPath - The current location pathname.
 * @param nextPath - The pathname being navigated to.
 * @returns True when the leave must be confirmed.
 * @throws {never} Never.
 */
export function shouldBlockLeave(
  hasPendingWork: boolean,
  currentPath: string,
  nextPath: string,
): boolean {
  return hasPendingWork && currentPath !== nextPath;
}

/** Navigation state that marks the landing after leaving the project. */
export interface LeftProjectState {
  leftProject: true;
}

/** The state `LeaveProjectFromPage` navigates with once the caller has left. */
export const LEFT_PROJECT_STATE: LeftProjectState = { leftProject: true };

/**
 * Whether a navigation is the landing that follows leaving the project. The
 * marker stays on that history entry, so Back or Forward onto it later
 * (`POP`) is an ordinary navigation and does not count.
 * @param nextLocation - Where the navigation goes.
 * @param historyAction - How it gets there.
 * @returns True for the landing itself.
 */
export function isLandingAfterLeave(
  nextLocation: Pick<Location, 'state'>,
  historyAction: NavigationType,
): boolean {
  if (historyAction === NavigationType.Pop) return false;
  const state = nextLocation.state as Partial<LeftProjectState> | null | undefined;
  return state?.leftProject === LEFT_PROJECT_STATE.leftProject;
}

/**
 * Confirms refresh and leave actions against this Project's current work.
 * @param props - Page-owned handle for the connection banner action.
 * @param props.ref - Receives the refresh action.
 * @returns The confirmation dialog (open only while a leave is blocked).
 * @throws {Error} When a browser reload fails.
 */
export function LeaveProjectGuard({ ref }: { ref?: React.Ref<LeaveProjectGuardHandle> }): React.JSX.Element {
  const t = useTranslation();
  const projectId = projectUuidFromRouteParam(useParams().projectId ?? '');
  const unsynced = useProjectUnsyncedEdits(projectId);
  const operations = useSpaceOperationsStore((state) => state.hasAnyOperations());
  const [refreshRequested, setRefreshRequested] = React.useState(false);
  const reloadApproved = React.useRef(false);
  const reloadFailed = t('project.refreshGuard.failed');

  /**
   * Reads risk at the action's event time.
   * @returns Whether local work requires confirmation.
   * @throws {never} Never.
   */
  const hasRisk = React.useCallback((): boolean =>
    hasProjectUnsyncedEdits(projectId) || useSpaceOperationsStore.getState().hasAnyOperations(), [projectId]);

  const blocker = useBlocker(
    React.useCallback(
      ({
        currentLocation,
        nextLocation,
        historyAction,
      }: {
        currentLocation: Location;
        nextLocation: Location;
        historyAction: NavigationType;
      }) =>
        !isLandingAfterLeave(nextLocation, historyAction) &&
        shouldBlockLeave(
          hasRisk(),
          currentLocation.pathname,
          nextLocation.pathname,
        ),
      [hasRisk],
    ),
  );
  const blocked = blocker.state === 'blocked';
  const open = blocked || refreshRequested;
  const returnFocus = useReturnFocus(open);

  React.useEffect(() => {
    if (blocked) setRefreshRequested(false);
  }, [blocked]);

  React.useEffect(() => {
    /**
     * Consumes explicit refresh approval or asks the browser to confirm risk.
     * @param event - Browser navigation event.
     * @throws {never} Never.
     */
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (reloadApproved.current) {
        reloadApproved.current = false;
        return;
      }
      if (!hasRisk()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    /**
     * Clears an unused approval when the user continues working.
     * @throws {never} Never.
     */
    const disarm = (): void => { reloadApproved.current = false; };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pointerdown', disarm, true);
    window.addEventListener('keydown', disarm, true);
    return (): void => {
      disarm();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pointerdown', disarm, true);
      window.removeEventListener('keydown', disarm, true);
    };
  }, [hasRisk]);

  /**
   * Reloads after the user has approved the current application action.
   * @throws {Error} Propagates reload failures after reporting them.
   */
  const reload = React.useCallback((): void => {
    reloadApproved.current = true;
    try {
      window.location.reload();
    } catch (err) {
      reloadApproved.current = false;
      toast.error(reloadFailed);
      throw err;
    }
  }, [reloadFailed]);

  /**
   * Opens a refresh choice for the current risk.
   * @throws {Error} Propagates reload failures.
   */
  const requestRefresh = React.useCallback((): void => {
    if (blocked) return;
    if (hasRisk()) setRefreshRequested(true);
    else reload();
  }, [blocked, hasRisk, reload]);

  React.useImperativeHandle(ref, () => ({ requestRefresh }), [requestRefresh]);

  const description = unsynced
    ? operations ? t('project.leaveGuard.combinedDescription') : t('project.leaveGuard.unsyncedDescription')
    : operations ? t('project.leaveGuard.description') : t('project.leaveGuard.completeDescription');
  // Set right before `proceed()` so the dialog's own close event (Radix fires
  // onOpenChange(false) when Action closes it) does not race a `reset()` that
  // would cancel the navigation we just allowed.
  const proceedingRef = React.useRef(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(open) => {
        if (open) return;
        if (proceedingRef.current) {
          proceedingRef.current = false;
          return;
        }
        if (blocker.state === 'blocked') blocker.reset();
        else setRefreshRequested(false);
      }}
    >
      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{blocked ? t('project.leaveGuard.title') : t('project.refreshGuard.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{blocked ? t('project.leaveGuard.stay') : t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (blocker.state === 'blocked') {
                proceedingRef.current = true;
                blocker.proceed();
              } else if (refreshRequested && !reloadApproved.current) {
                setRefreshRequested(false);
                reload();
              }
            }}
          >
            {blocked ? t('project.leaveGuard.leave') : t('project.refreshGuard.refresh')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
