// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { StudioProjectSort } from '@breatic/shared';

import type { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import type { ContainerProject, ProjectTimeKind } from '@web/pages/studio/container/container-types';

type Translate = ReturnType<typeof useTranslation>;

/**
 * Which time a card shows under a sort. Sorting by name shows the edit time on
 * the live list and the archive time on the archived one, the time a reader
 * scanning by name most likely wants next.
 * @param sort - The list's sort.
 * @param archived - Whether this is the archived list.
 * @returns The time the card's meta line carries.
 */
export function timeKindForSort(sort: StudioProjectSort, archived: boolean): ProjectTimeKind {
  if (sort === 'name') return archived ? 'archived' : 'edited';
  return sort;
}

/**
 * One of the project's times.
 * @param project - The project.
 * @param kind - Which time.
 * @returns The ISO time, or null for a project never opened by the viewer or not archived.
 */
export function projectTime(project: ContainerProject, kind: ProjectTimeKind): string | null {
  switch (kind) {
    case 'opened':
      return project.lastOpenedAt;
    case 'edited':
      return project.lastEditedAt;
    case 'archived':
      return project.archivedAt;
    case 'created':
      return project.createdAt;
  }
}

const LINE_KEY: Record<ProjectTimeKind, string> = {
  opened: 'studio.container.card.openedAt',
  edited: 'studio.container.card.editedAt',
  archived: 'studio.container.card.archivedAt',
  created: 'studio.container.card.createdAt',
};

/**
 * The card's meta line for one of the project's times. A project the viewer
 * never opened says only that.
 * @param project - The project.
 * @param kind - Which time to show.
 * @param t - The translator.
 * @returns The localized line.
 */
export function projectTimeLine(project: ContainerProject, kind: ProjectTimeKind, t: Translate): string {
  const at = projectTime(project, kind);
  const created = formatRelativeTime(project.createdAt, t);
  if (at !== null) return t(LINE_KEY[kind], { time: formatRelativeTime(at, t) });
  if (kind === 'opened') return t('studio.container.card.neverOpened');
  return t(LINE_KEY.created, { time: created });
}
