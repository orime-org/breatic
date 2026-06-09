// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { studiosApi } from '@web/data/api/studios';
import { NewItemDialog } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { NewStudioDialog } from '@web/pages/studio/container/dialogs/NewStudioDialog';
import {
  creatableStudios,
  defaultCreateStudioId,
} from '@web/pages/studio/container/dialogs/studio-create';
import { useCreateProject } from '@web/pages/studio/container/dialogs/use-create-project';
import { StudioRail } from '@web/pages/studio/rail/StudioRail';
import { StudioRailDrawer } from '@web/pages/studio/rail/StudioRailDrawer';
import { StudioTopBar } from '@web/pages/studio/shell/StudioTopBar';

/** Context the studio layout passes through `<Outlet>` to its child routes. */
export interface StudioLayoutContext {
  /** Opens the create-project dialog (used by the Recent empty-state CTA). */
  onCreateProject: () => void;
}

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
 * The create-project entry opens the dialog with its studio selector (spec §7);
 * as a global entry it defaults to the personal studio, and on submit the
 * shared `useCreateProject` flow creates the project and navigates to the
 * target studio so the new card appears.
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
  const [createStudioOpen, setCreateStudioOpen] = React.useState(false);
  const createProject = useCreateProject(studios);
  // The rail's create-project is a GLOBAL entry (not inside a studio), so the
  // selector defaults to the personal studio (the viewer is always its admin).
  const creatable = creatableStudios(studios);
  const defaultStudioId = defaultCreateStudioId(studios);

  return (
    <div className='flex h-screen flex-col bg-background text-foreground'>
      <StudioTopBar
        leading={
          <StudioRailDrawer
            studios={studios}
            activeSlug={slug ?? null}
            onCreateProject={() => setCreateOpen(true)}
            onCreateStudio={() => setCreateStudioOpen(true)}
          />
        }
      />
      <div className='flex min-h-0 flex-1'>
        <StudioRail
          studios={studios}
          activeSlug={slug ?? null}
          onCreateProject={() => setCreateOpen(true)}
          onCreateStudio={() => setCreateStudioOpen(true)}
        />
        <main className='min-w-0 flex-1 overflow-hidden'>
          <Outlet
            context={
              {
                onCreateProject: () => setCreateOpen(true),
              } satisfies StudioLayoutContext
            }
          />
        </main>
      </div>
      <NewItemDialog
        kind='project'
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={createProject}
        studios={creatable}
        defaultStudioId={defaultStudioId}
      />
      <NewStudioDialog
        open={createStudioOpen}
        onOpenChange={setCreateStudioOpen}
      />
    </div>
  );
}
