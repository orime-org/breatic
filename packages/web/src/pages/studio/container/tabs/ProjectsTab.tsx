// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Folder } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import { canRenderItemCard } from '@web/pages/studio/container/access';
import { ContainerToolbar } from '@web/pages/studio/container/ContainerToolbar';
import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import { EmptyState } from '@web/pages/studio/shared/EmptyState';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import {
  NewItemDialog,
  type NewItemValues,
} from '@web/pages/studio/container/dialogs/NewItemDialog';
import { canCreateInStudio } from '@web/pages/studio/container/access';
import type {
  StudioRole,
  StudioSummary,
} from '@web/pages/studio/shared/studio-types';

interface ProjectsTabProps {
  projects: readonly ContainerProject[];
  /** The viewer's studio role (`null` = guest) — drives the visibility filter (invariant 1). */
  studioRole: StudioRole | null;
  /** Called when a project is created via the dialog (stub no-op in slice 3). */
  onCreateProject?: (values: NewItemValues) => void;
  /** The studios the viewer may create in — rendered as the dialog's selector (spec §7.1). */
  creatableStudios?: readonly StudioSummary[];
  /** The studio pre-selected when the create dialog opens. */
  defaultStudioId?: string;
}

// Auto-fill grid (neutral mock §grid): cards are min 190px wide, so the row
// packs up to ~5 columns at the 1100px container width and reflows down.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3';

/**
 * The Projects tab (spec §3.3 / §3.13): a toolbar (title + count + sort/view
 * placeholders + create button) over a card grid of the studio's projects,
 * filtered by the viewer's access (spec §4 invariant 1 — Members never see
 * private projects they are not part of). When there are no visible projects,
 * the toolbar stays and an empty-state line shows below it (the create button
 * in the toolbar is the entry point — locked mock dropped the in-grid card).
 * @param props the projects, the viewer's studio role and the create callback.
 * @param props.projects the studio's projects.
 * @param props.studioRole the viewer's studio role.
 * @param props.onCreateProject called when a project is created via the dialog.
 * @param props.creatableStudios the studios the viewer may create in (selector).
 * @param props.defaultStudioId the studio pre-selected when the dialog opens.
 * @returns the Projects tab content.
 */
export function ProjectsTab({
  projects,
  studioRole,
  onCreateProject,
  creatableStudios,
  defaultStudioId,
}: ProjectsTabProps): React.JSX.Element {
  const t = useTranslation();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  // Only an admin/creator of THIS studio sees the create entry (spec §7.1):
  // studio credits are shared, so a plain member must not be able to spend them
  // by creating. A guest (`null`) never sees it either. The dialog's selector
  // can still target a different studio the viewer may create in.
  const canCreate = canCreateInStudio(studioRole);
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
        <EmptyState
          icon={Folder}
          title={t('studio.container.projects.emptyTitle')}
          hint={t('studio.container.projects.emptyHint')}
        />
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
          studios={creatableStudios}
          defaultStudioId={defaultStudioId}
        />
      ) : null}
    </>
  );
}
