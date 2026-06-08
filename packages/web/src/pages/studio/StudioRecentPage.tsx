// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { useOutletContext } from 'react-router-dom';

import { RecentLanding } from '@web/pages/studio/recent/RecentLanding';
import type { StudioLayoutContext } from '@web/pages/studio/shell/StudioLayout';

/**
 * The cross-studio "Recent" landing (spec §4.5) — the index child of the studio
 * layout route, rendered at `/studio` (the login-default view). `/studio` IS the
 * Recent view (URL design §5.7): Recent is per-user / account-bound, so there is
 * no `/studio/recent` URL. Renders ONLY the recent content — the rail + top bar
 * come from `StudioLayout`.
 *
 * The cross-studio recent feed (`GET /studio/recent`) does not exist yet, so the
 * landing receives empty lists and shows its composed empty state (never invented
 * data); wiring the real feed is a later slice. The empty-state CTA opens the
 * layout's create-project dialog via Outlet context.
 * @returns the cross-studio recent landing content.
 */
export default function StudioRecentPage(): React.JSX.Element {
  const { onCreateProject } = useOutletContext<StudioLayoutContext>();
  return (
    <div className='h-full overflow-auto'>
      <RecentLanding
        projects={[]}
        collections={[]}
        onCreateProject={onCreateProject}
      />
    </div>
  );
}
