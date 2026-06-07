// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { canRenderItemCard } from '@web/pages/studio/container/access';
import { ContainerToolbar } from '@web/pages/studio/container/ContainerToolbar';
import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import {
  NewItemDialog,
  type NewItemValues,
} from '@web/pages/studio/container/dialogs/NewItemDialog';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface ProjectsTabProps {
  projects: readonly ContainerProject[];
  /** The viewer's studio role (`null` = guest) — drives the visibility filter (invariant 1). */
  studioRole: StudioRole | null;
  /** Called when a project is created via the dialog (stub no-op in slice 3). */
  onCreateProject?: (values: NewItemValues) => void;
}

// Auto-fill grid (mock定稿): cards are ~236px wide, so the row packs up to
// ~5 columns at the 1320px container width and reflows down on narrow screens.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3';

/**
 * The Projects tab (spec §3.3 / §3.13): a toolbar (title + count + sort/view
 * placeholders + create button) over a card grid of the studio's projects,
 * filtered by the viewer's access (spec §4 invariant 1 — Members never see
 * private projects they are not part of). When there are no visible projects,
 * the toolbar stays and an empty-state line shows below it (the create button
 * in the toolbar is the entry point — mock定稿 dropped the in-grid新建卡).
 * @param props the projects, the viewer's studio role and the create callback.
 * @param props.projects the studio's projects.
 * @param props.studioRole the viewer's studio role.
 * @param props.onCreateProject called when a project is created via the dialog.
 * @returns the Projects tab content.
 */
export function ProjectsTab({
  projects,
  studioRole,
  onCreateProject,
}: ProjectsTabProps): React.JSX.Element {
  const t = useTranslation();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  // Only studio members create projects. A guest (`null` studio role) viewing
  // the public shell never sees the create entry — `create` always targets the
  // caller's own studio, so offering it on someone else's studio would misfire.
  const canCreate = studioRole !== null;
  const visible = projects.filter((project) =>
    canRenderItemCard(studioRole, project),
  );
  return (
    <>
      <ContainerToolbar
        title={t('studio.container.tabs.projects')}
        count={visible.length}
        createLabel={t('studio.container.projects.new')}
        onCreate={canCreate ? () => setDialogOpen(true) : undefined}
      />
      {visible.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('studio.container.projects.empty')}
        </p>
      ) : (
        <div className={GRID}>
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              studioRole={studioRole}
            />
          ))}
        </div>
      )}
      {canCreate ? (
        <NewItemDialog
          kind='project'
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreate={onCreateProject}
        />
      ) : null}
    </>
  );
}
