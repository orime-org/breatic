// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { RecentLanding } from '@web/pages/studio/recent/RecentLanding';
import {
  STUB_RECENT_COLLECTIONS,
  STUB_RECENT_PROJECTS,
} from '@web/pages/studio/recent/recent-stub';
import { StudioTopBar } from '@web/pages/studio/shell/StudioTopBar';

/**
 * Studio page (`/studio`) — the cross-studio "Recent" landing (spec §2.1),
 * the login-default screen. `/studio` IS the Recent view itself (URL design
 * §5.7, B correction): Recent is per-user / account-bound, so there is no
 * `/studio/recent` URL. Renders the app top bar over the two-section
 * recent grid.
 *
 * Data is currently stubbed (frontend-on-stub, slice 2): Phase 2 wires the
 * real `GET /studio/recent`. The studio container (5 tabs at `/studio/{slug}`,
 * with real project / collection / member / credits / settings views) lands
 * in a later slice.
 * @returns the studio top bar above the recent landing.
 */
export default function StudioPage(): React.JSX.Element {
  return (
    <div className='flex h-screen flex-col bg-background text-foreground'>
      <StudioTopBar />
      <main className='flex-1 overflow-auto'>
        <RecentLanding
          projects={[...STUB_RECENT_PROJECTS]}
          collections={[...STUB_RECENT_COLLECTIONS]}
        />
      </main>
    </div>
  );
}
