// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';

// How many waits are open right now. The screen is one element for the whole
// app, so a wait that hands over to the next one leaves it where it is: the
// spinner keeps turning instead of starting again from the top.
let openWaits = 0;
const listeners = new Set<() => void>();

/**
 * Subscribe to changes in the number of open waits.
 * @param listener - Called after every change.
 * @returns The unsubscribe function.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read the number of open waits.
 * @returns How many `LoadingScreen` waits are mounted.
 */
function readOpenWaits(): number {
  return openWaits;
}

/**
 * Open or close one wait and tell the screen.
 * @param delta - `1` when a wait opens, `-1` when it closes.
 */
function changeOpenWaits(delta: 1 | -1): void {
  openWaits += delta;
  for (const listener of listeners) listener();
}

/**
 * A wait for the full-screen loading screen: while it is mounted, the screen
 * shows.
 *
 * Four places wait: `ProtectedRoute` while the boot `/auth/me` ping decides
 * whether the reader may be here, `LoadingBoundary` while a route's chunk is
 * on the wire, and `ProjectPage` twice — while the project and the reader's
 * preferences load, then while the Hocuspocus connection settles (without that
 * wait the page paints once with `connectionStatus === 'connecting'` and the
 * banner and workspace overlay pop in on the next frame, 2026-05-26 user spec).
 * Entering a project from inside the app runs the last three back to back; a
 * cold load of the project address runs all four. Each renders this, and
 * `LoadingScreenHost` draws the one screen they all share, so the hand-over
 * from one wait to the next leaves the screen and its spinner untouched
 * (inner#1373).
 *
 * The count is taken in a layout effect: a wait that unmounts and the one that
 * replaces it change it in the same commit, before paint, so the screen never
 * sees zero in between. React also tears down the layout effects of a tree a
 * Suspense boundary hides, which takes a hidden wait out of the count.
 * @returns Nothing; the screen itself is drawn by `LoadingScreenHost`.
 */
export function LoadingScreen(): null {
  React.useLayoutEffect(() => {
    changeOpenWaits(1);
    return () => {
      changeOpenWaits(-1);
    };
  }, []);
  return null;
}

/**
 * The full-screen loading screen: full viewport, centred spinner, localized
 * "Loading...". Mounted once at the app root and shown while any
 * `LoadingScreen` wait is open.
 * @returns The screen while a wait is open, otherwise nothing.
 */
export function LoadingScreenHost(): React.JSX.Element | null {
  const waits = React.useSyncExternalStore(subscribe, readOpenWaits);
  const t = useTranslation();
  if (waits === 0) return null;
  return (
    <div
      role='status'
      aria-live='polite'
      data-testid='loading-screen'
      className='fixed inset-0 flex items-center justify-center bg-background text-muted-foreground'
    >
      <div className='flex flex-col items-center gap-3'>
        <Loader2 className='h-6 w-6 animate-spin' aria-hidden />
        <span className='text-sm'>{t('common.loading')}</span>
      </div>
    </div>
  );
}
