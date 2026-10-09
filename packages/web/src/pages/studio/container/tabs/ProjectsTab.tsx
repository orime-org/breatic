// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Folder } from 'lucide-react';

import type { StudioProjectSort } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { ContainerToolbar } from '@web/pages/studio/container/ContainerToolbar';
import { LIST_SORTS } from '@web/pages/studio/container/list-prefs';
import { ProjectListBody } from '@web/pages/studio/container/ProjectListBody';
import { EmptyState } from '@web/pages/studio/shared/EmptyState';
import type { ProjectListView } from '@web/pages/studio/container/container-types';
import type { StudioProjectList } from '@web/pages/studio/container/use-studio-projects-paging';
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
  /** The studio's live projects, as loaded so far. */
  list: StudioProjectList;
  sort: StudioProjectSort;
  onSortChange: (sort: StudioProjectSort) => void;
  view: ProjectListView;
  onViewChange: (view: ProjectListView) => void;
  /** The viewer's studio role (`null` = non-member) — decides whether the create entry shows. */
  studioRole: StudioRole | null;
  /** Called when a project is created via the dialog (stub no-op in slice 3). */
  onCreateProject?: (values: NewItemValues) => void;
  /** The studios the viewer may create in — rendered as the dialog's selector (spec §7.1). */
  creatableStudios?: readonly StudioSummary[];
  /** The studio pre-selected when the create dialog opens. */
  defaultStudioId?: string;
}

/**
 * The Projects tab (spec §3.3 / §3.13): a toolbar (title + total + sort +
 * grid/list switch + create button) over the studio's projects, loaded a page
 * at a time. When there are no projects, the toolbar stays and an empty-state
 * line shows below it (the create button in the toolbar is the entry point —
 * locked mock dropped the in-grid card).
 * @param props the list, its sort and view, the viewer's studio role and the create callback.
 * @param props.list the studio's live projects, as loaded so far.
 * @param props.sort the list's sort.
 * @param props.onSortChange changes the sort.
 * @param props.view grid or list.
 * @param props.onViewChange changes the view.
 * @param props.studioRole the viewer's studio role.
 * @param props.onCreateProject called when a project is created via the dialog.
 * @param props.creatableStudios the studios the viewer may create in (selector).
 * @param props.defaultStudioId the studio pre-selected when the dialog opens.
 * @returns the Projects tab content.
 */
export function ProjectsTab({
  list,
  sort,
  onSortChange,
  view,
  onViewChange,
  studioRole,
  onCreateProject,
  creatableStudios,
  defaultStudioId,
}: ProjectsTabProps): React.JSX.Element {
  const t = useTranslation();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  // Only an admin/maintainer of THIS studio sees the create entry (spec §7.1);
  // a plain guest must not be able to create. A non-member (`null`) never sees
  // it either. The dialog's selector
  // can still target a different studio the viewer may create in.
  const canCreate = canCreateInStudio(studioRole);
  return (
    <>
      <ContainerToolbar
        title={t('studio.container.tabs.projects')}
        count={list.total}
        createLabel={t('studio.container.projects.new')}
        onCreate={canCreate ? () => setDialogOpen(true) : undefined}
        sort={{ value: sort, options: LIST_SORTS.projects, onChange: onSortChange }}
        view={{ value: view, onChange: onViewChange }}
      />
      <ProjectListBody
        list={list}
        archived={false}
        sort={sort}
        view={view}
        empty={
          <EmptyState
            icon={Folder}
            title={t('studio.container.projects.emptyTitle')}
            hint={t('studio.container.projects.emptyHint')}
          />
        }
      />
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
