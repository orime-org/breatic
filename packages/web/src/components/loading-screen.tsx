// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Loader2 } from 'lucide-react';
import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';

/**
 * The screen every wait in the app shows: full viewport, centred spinner,
 * localized "Loading...".
 *
 * Three places render it, and a reader moving between them sees one
 * uninterrupted screen. `LoadingBoundary` shows it while a route's chunk is on
 * the wire — one boundary for all thirteen entries, so they cannot drift into
 * showing different waiting screens. `ProtectedRoute` shows it while the boot
 * `/auth/me` ping decides whether the reader may be here at all; that wait
 * runs first, and React holds the suspended one hidden beside the fallback
 * rather than unmounting it, so the two read as one (measured: both are in
 * the DOM under `#root`, the earlier one at `display: none`).
 *
 * `ProjectPage` shows it while the Hocuspocus connection settles. Without it
 * that page paints once with `connectionStatus === 'connecting'` — banner and
 * workspace overlay both bail to null — and then the websocket auth fails and
 * both pop in on the next frame. Waiting defers the mount until the status is
 * final, so they arrive with the page on a single frame (2026-05-26 user spec).
 * @returns The full-viewport centered spinner with localized loading text.
 */
export function LoadingScreen(): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      role='status'
      aria-live='polite'
      data-testid='loading-screen'
      className='flex h-screen w-screen items-center justify-center bg-background text-muted-foreground'
    >
      <div className='flex flex-col items-center gap-3'>
        <Loader2 className='h-6 w-6 animate-spin' aria-hidden />
        <span className='text-sm'>{t('common.loading')}</span>
      </div>
    </div>
  );
}
