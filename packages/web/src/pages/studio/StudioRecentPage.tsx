// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { RecentLanding } from '@web/pages/studio/recent/RecentLanding';
import {
  STUB_RECENT_COLLECTIONS,
  STUB_RECENT_PROJECTS,
} from '@web/pages/studio/recent/recent-stub';

/**
 * The cross-studio "Recent" landing (spec §4.5) — the index child of the
 * studio layout route, rendered at `/studio` (the login-default view). `/studio`
 * IS the Recent view itself (URL design §5.7): Recent is per-user / account-
 * bound, so there is no `/studio/recent` URL. This component renders ONLY the
 * recent content — the rail + top bar are provided by `StudioLayout`.
 *
 * Data is still stubbed; wiring the real `GET /studio/recent` (the cross-studio
 * recent projects + collections) is a later slice.
 * @returns the cross-studio recent landing content.
 */
export default function StudioRecentPage(): React.JSX.Element {
  return (
    <div className='h-full overflow-auto'>
      <RecentLanding
        projects={[...STUB_RECENT_PROJECTS]}
        collections={[...STUB_RECENT_COLLECTIONS]}
      />
    </div>
  );
}
