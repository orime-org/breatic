// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import type { StudioProjectSort } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import { hasCardMenu, ProjectCardMenu } from '@web/pages/studio/container/cards/ProjectCardMenu';
import { ProjectOpenTarget, ROLE_KEY } from '@web/pages/studio/container/cards/ProjectOpenTarget';
import type { ContainerProject, ProjectListView, ProjectTimeKind } from '@web/pages/studio/container/container-types';
import { projectTime, timeKindForSort } from '@web/pages/studio/container/project-time';
import type { StudioProjectList } from '@web/pages/studio/container/use-studio-projects-paging';
import { DefaultProjectCover } from '@web/ui/DefaultProjectCover';

type Translate = ReturnType<typeof useTranslation>;

// Auto-fill grid (neutral mock §grid): cards are min 190px wide, so the row
// packs up to ~5 columns at the 1100px container width and reflows down.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3';
const FIRST_PAGE_PLACEHOLDERS = 8;
const NEXT_PAGE_PLACEHOLDERS = 4;
const ROW_PLACEHOLDERS = 3;

type Column = 'name' | ProjectTimeKind;

const TIME_COLUMNS = {
  live: ['opened', 'edited', 'created'],
  archived: ['archived', 'edited', 'created'],
} as const satisfies Record<string, readonly ProjectTimeKind[]>;

interface ProjectListBodyProps {
  list: StudioProjectList;
  /** The archived list instead of the live one. */
  archived: boolean;
  sort: StudioProjectSort;
  view: ProjectListView;
  /** What shows when the list holds no projects. */
  empty: React.ReactNode;
}

/**
 * The body of a studio project list under its toolbar: the first-load
 * placeholders or failure, the empty state, or the projects as cards or table
 * rows followed by the list's tail — placeholders while the next page loads,
 * a retry when it did not arrive, the project count once everything is in.
 * @param props - The list, which one it is, how it is sorted and shown.
 * @param props.list - The list state.
 * @param props.archived - Whether this is the archived list.
 * @param props.sort - The list's sort.
 * @param props.view - Cards or table rows.
 * @param props.empty - The empty state.
 * @returns The list body.
 */
export function ProjectListBody({ list, archived, sort, view, empty }: ProjectListBodyProps): React.JSX.Element {
  const t = useTranslation();
  if (list.firstPageFailed) {
    return (
      <div role='alert' className='flex flex-col items-center gap-3 px-4 py-[72px] text-center text-sm text-muted-foreground'>
        {t('studio.container.list.loadFailed')}
        <Button type='button' variant='outline' size='sm' onClick={list.retryFirstPage}>
          {t('studio.container.list.retry')}
        </Button>
      </div>
    );
  }
  if (!list.isPending && list.projects.length === 0 && !list.hasNextPage) return <>{empty}</>;

  const loadingMore = list.isPending || list.isFetchingNextPage;
  return (
    <>
      {view === 'grid' ? (
        <div className={GRID}>
          {list.projects.map((project) => (
            <ProjectCard key={project.id} project={project} timeKind={timeKindForSort(sort, archived)} />
          ))}
          {loadingMore
            ? Array.from({ length: list.isPending ? FIRST_PAGE_PLACEHOLDERS : NEXT_PAGE_PLACEHOLDERS }, (_, i) => (
              <CardPlaceholder key={i} />
            ))
            : null}
        </div>
      ) : (
        <ProjectTable
          projects={list.projects}
          columns={archived ? TIME_COLUMNS.archived : TIME_COLUMNS.live}
          sorted={sort === 'name' ? 'name' : sort}
          placeholders={loadingMore ? ROW_PLACEHOLDERS : 0}
        />
      )}
      {list.hasNextPage ? <div ref={list.sentinelRef} aria-hidden='true' /> : null}
      {list.pageFailed ? (
        <div role='alert' className='flex items-center justify-center gap-2.5 pt-[18px] text-xs text-muted-foreground'>
          {t('studio.container.list.pageFailed')}
          <Button type='button' variant='outline' size='sm' onClick={list.loadMore}>
            {t('studio.container.list.retry')}
          </Button>
        </div>
      ) : null}
      {!list.isPending && !list.hasNextPage ? (
        <p className='pt-[18px] text-center text-xs text-muted-foreground'>
          {t('studio.container.list.end', { count: list.total ?? list.projects.length })}
        </p>
      ) : null}
    </>
  );
}

/**
 * A card-shaped placeholder: a cover and two text lines.
 * @returns The placeholder.
 */
function CardPlaceholder(): React.JSX.Element {
  return (
    <div data-testid='project-placeholder' className='overflow-hidden rounded-chrome border border-border bg-card'>
      <Skeleton className='aspect-video w-full rounded-none' />
      <div className='flex flex-col gap-2 px-3 pb-3 pt-2.5'>
        <Skeleton className='h-4 w-1/2' />
        <Skeleton className='h-3 w-2/3' />
      </div>
    </div>
  );
}

interface ProjectTableProps {
  projects: readonly ContainerProject[];
  columns: readonly ProjectTimeKind[];
  sorted: Column;
  placeholders: number;
}

// The border colour is translucent, so a cell's fill stops at its padding: a
// highlighted row would otherwise show through its own bottom line.
const CELL = 'border-b border-border bg-clip-padding px-3 py-2 align-middle';

/**
 * The list view: a cover column, the name and three times, and the viewer's
 * role with the project's menu at the row's end. The sorted column's header is
 * marked; a row opens its project.
 * @param props - The rows, columns, and placeholders.
 * @param props.projects - The projects.
 * @param props.columns - The time columns, in order.
 * @param props.sorted - The column the list is sorted by.
 * @param props.placeholders - How many placeholder rows follow the projects.
 * @returns The table.
 */
function ProjectTable({ projects, columns, sorted, placeholders }: ProjectTableProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <table className='w-full border-separate border-spacing-0 text-left text-sm'>
      <thead className='text-xs text-muted-foreground'>
        <tr>
          <th className='w-px border-b border-border px-3 pb-2 font-medium' />
          {(['name', ...columns] as const).map((column) => (
            <th
              key={column}
              aria-sort={column !== sorted ? undefined : column === 'name' ? 'ascending' : 'descending'}
              className={`whitespace-nowrap border-b border-border px-3 pb-2 font-medium ${column === sorted ? 'text-foreground' : ''}`}
            >
              {t(`studio.container.list.columns.${column}`)}
            </th>
          ))}
          <th className='whitespace-nowrap border-b border-border px-3 pb-2 font-medium'>
            {t('studio.container.list.columns.role')}
          </th>
        </tr>
      </thead>
      <tbody>
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} columns={columns} />
        ))}
        {Array.from({ length: placeholders }, (_, i) => (
          <tr key={`placeholder-${i}`} data-testid='project-placeholder'>
            <td className={`${CELL} w-px pr-0`}>
              <Skeleton className='aspect-video w-12 rounded-content-sm' />
            </td>
            <td className={CELL}>
              <Skeleton className='h-3.5 w-2/5' />
            </td>
            {columns.map((column) => (
              <td key={column} className={CELL}>
                <Skeleton className='h-3 w-16' />
              </td>
            ))}
            <td className={CELL} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A time cell's text.
 * @param project - The row's project.
 * @param column - The time column.
 * @param t - The translator.
 * @returns The relative time, or the never-opened note.
 */
function timeCell(project: ContainerProject, column: ProjectTimeKind, t: Translate): string {
  const at = projectTime(project, column);
  if (at !== null) return formatRelativeTime(at, t);
  return column === 'opened' ? t('studio.container.list.neverOpened') : '—';
}

// Stretches the name's link or button over the whole row, so the row opens
// the project; the menu sits above it.
const STRETCH =
  'rounded-none text-left font-medium text-foreground focus-visible:outline-none after:absolute after:inset-0 after:content-[""]';

/**
 * One project row. Its name opens the project the way the card does
 * ({@link ProjectOpenTarget}), stretched over the whole row.
 * @param props - The row's project and columns.
 * @param props.project - The project.
 * @param props.columns - The time columns, in order.
 * @returns The row.
 */
function ProjectRow({ project, columns }: { project: ContainerProject; columns: readonly ProjectTimeKind[] }): React.JSX.Element {
  const t = useTranslation();
  return (
    <tr
      data-testid={`project-row-${project.id}`}
      className='relative text-muted-foreground hover:[&>td]:bg-accent has-[:focus-visible]:[&>td]:bg-accent'
    >
      <td className={`${CELL} w-px pr-0`}>
        <div className='aspect-video w-12 overflow-hidden rounded-content-sm bg-muted text-muted-foreground'>
          {project.thumbnailUrl ? (
            <img src={project.thumbnailUrl} alt='' className='h-full w-full object-cover' loading='lazy' />
          ) : (
            <DefaultProjectCover />
          )}
        </div>
      </td>
      <td className={`${CELL} w-full max-w-0 truncate`}>
        <ProjectOpenTarget project={project} className={STRETCH}>
          {project.name}
        </ProjectOpenTarget>
      </td>
      {columns.map((column) => (
        <td key={column} className={`${CELL} whitespace-nowrap text-xs`}>
          {timeCell(project, column, t)}
        </td>
      ))}
      <td className={`${CELL} whitespace-nowrap text-xs`}>
        <span className='flex items-center justify-between gap-2'>
          {project.myRole === null ? '—' : t(ROLE_KEY[project.myRole])}
          {hasCardMenu(project) ? <ProjectCardMenu project={project} placement='row' /> : null}
        </span>
      </td>
    </tr>
  );
}
