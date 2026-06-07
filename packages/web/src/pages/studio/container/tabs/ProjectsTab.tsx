// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { canRenderItemCard } from '@web/pages/studio/container/access';
import { NewItemCard } from '@web/pages/studio/container/cards/NewItemCard';
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

const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3';

/**
 * The Projects tab (spec §3.3 / §3.13): a card grid of the studio's projects,
 * filtered by the viewer's access (spec §4 invariant 1 — Members never see
 * private projects they are not part of), with a trailing "new project" card
 * that opens the create dialog. When there are no visible projects, only the
 * new-project card is shown.
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
  const newCard = canCreate ? (
    <NewItemCard
      label={t('studio.container.projects.new')}
      onClick={() => setDialogOpen(true)}
    />
  ) : null;
  return (
    <>
      {visible.length === 0 ? (
        <div>
          <p className='mb-4 text-sm text-muted-foreground'>
            {t('studio.container.projects.empty')}
          </p>
          {newCard ? <div className={GRID}>{newCard}</div> : null}
        </div>
      ) : (
        <div className={GRID}>
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              studioRole={studioRole}
            />
          ))}
          {newCard}
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
