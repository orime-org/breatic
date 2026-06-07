// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { studiosApi } from '@web/data/api/studios';
import { NewItemDialog } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { StudioRail } from '@web/pages/studio/rail/StudioRail';
import { StudioTopBar } from '@web/pages/studio/shell/StudioTopBar';

/**
 * Studio layout (spec §3.1 — the layout route that makes the rail + top bar
 * persistent). It wraps both `/studio` (the Recent landing) and
 * `/studio/{slug}` (the studio container): the left rail and the top bar mount
 * ONCE here, and the child route renders in `<Outlet/>`, so navigating between
 * studios swaps only the center content — the rail keeps its mount, selection
 * and ④⑤ collapse state (invariant #3 — switching studio loses no state).
 *
 * The rail's studio list comes from `GET /studios` (the viewer's active
 * memberships; React Query dedupes against the container's identical query).
 * The active slug comes from the matched child route param (`null` on Recent).
 * The create-project entry opens the dialog; its studio selector + the real
 * create wiring land in a later slice (§7).
 * @returns the studio layout shell (rail + top bar over the routed content).
 */
export default function StudioLayout(): React.JSX.Element {
  const { slug } = useParams();
  const studiosQuery = useQuery({
    queryKey: ['studios', 'user'],
    queryFn: () => studiosApi.listUserStudios(),
  });
  const studios = studiosQuery.data ?? [];
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <div className='flex h-screen bg-background text-foreground'>
      <StudioRail
        studios={studios}
        activeSlug={slug ?? null}
        onCreateProject={() => setCreateOpen(true)}
      />
      <div className='flex min-w-0 flex-1 flex-col'>
        <StudioTopBar />
        <main className='min-h-0 flex-1 overflow-hidden'>
          <Outlet />
        </main>
      </div>
      <NewItemDialog
        kind='project'
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
