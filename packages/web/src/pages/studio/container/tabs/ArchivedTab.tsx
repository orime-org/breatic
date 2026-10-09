// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { Archive } from 'lucide-react';
import type { StudioProjectSort } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { ContainerToolbar } from '@web/pages/studio/container/ContainerToolbar';
import type { ProjectListView } from '@web/pages/studio/container/container-types';
import { LIST_SORTS } from '@web/pages/studio/container/list-prefs';
import { ProjectListBody } from '@web/pages/studio/container/ProjectListBody';
import type { StudioProjectList } from '@web/pages/studio/container/use-studio-projects-paging';
import { EmptyState } from '@web/pages/studio/shared/EmptyState';

interface ArchivedTabProps {
  /** The studio's archived projects, as loaded so far. */
  list: StudioProjectList;
  sort: StudioProjectSort;
  onSortChange: (sort: StudioProjectSort) => void;
  view: ProjectListView;
  onViewChange: (view: ProjectListView) => void;
}

/**
 * The Archived tab, the studio admin's alone: the studio's archived projects as
 * the same cards or rows the Projects tab uses, each carrying a menu that only
 * restores, sorted by archive time, name or creation time. Nothing is created
 * from here.
 * @param props - The list and its sort and view.
 * @param props.list - The studio's archived projects, as loaded so far.
 * @param props.sort - The list's sort.
 * @param props.onSortChange - Changes the sort.
 * @param props.view - Grid or list.
 * @param props.onViewChange - Changes the view.
 * @returns The Archived tab content.
 */
export function ArchivedTab({ list, sort, onSortChange, view, onViewChange }: ArchivedTabProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <>
      <ContainerToolbar
        title={t('studio.container.tabs.archived')}
        count={list.total}
        sort={{ value: sort, options: LIST_SORTS.archived, onChange: onSortChange }}
        view={{ value: view, onChange: onViewChange }}
      />
      <ProjectListBody
        list={list}
        archived
        sort={sort}
        view={view}
        empty={
          <EmptyState
            icon={Archive}
            title={t('studio.container.archived.emptyTitle')}
            hint={t('studio.container.archived.emptyHint')}
          />
        }
      />
    </>
  );
}
