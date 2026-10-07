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
 * The card's meta line for one of the project's times.
 * @param project - The project.
 * @param kind - Which time to show.
 * @param t - The translator.
 * @returns The localized line.
 */
export function projectTimeLine(project: ContainerProject, kind: ProjectTimeKind, t: Translate): string {
  const created = formatRelativeTime(project.createdAt, t);
  switch (kind) {
    case 'opened':
      return project.lastOpenedAt === null
        ? t('studio.container.card.neverOpened', { time: created })
        : t('studio.container.card.openedAt', { time: formatRelativeTime(project.lastOpenedAt, t) });
    case 'edited':
      return t('studio.container.card.editedAt', { time: formatRelativeTime(project.lastEditedAt, t) });
    case 'archived':
      return project.archivedAt === null
        ? t('studio.container.card.createdAt', { time: created })
        : t('studio.container.card.archivedAt', { time: formatRelativeTime(project.archivedAt, t) });
    case 'created':
      return t('studio.container.card.createdAt', { time: created });
  }
}
