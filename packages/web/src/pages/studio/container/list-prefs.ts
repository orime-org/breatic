// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { ARCHIVED_PROJECT_SORTS, LIVE_PROJECT_SORTS } from '@breatic/shared';
import type { StudioProjectSort } from '@breatic/shared';

import type { ProjectListView } from '@web/pages/studio/container/container-types';

/** The two lists a studio page sorts and lays out. */
export type StudioListTab = 'projects' | 'archived';

/** A list's sort and layout, and how to change them. */
export interface StudioListPrefs {
  sort: StudioProjectSort;
  view: ProjectListView;
  setSort: (sort: StudioProjectSort) => void;
  setView: (view: ProjectListView) => void;
}

/** The sorts each list offers, its default first. */
export const LIST_SORTS: Record<StudioListTab, readonly StudioProjectSort[]> = {
  projects: LIVE_PROJECT_SORTS,
  archived: ARCHIVED_PROJECT_SORTS,
};

const VIEWS: readonly ProjectListView[] = ['grid', 'list'];

/**
 * The storage key for one studio's list.
 * @param studioId - The studio.
 * @param tab - The list.
 * @returns The key.
 */
function storageKey(studioId: string, tab: StudioListTab): string {
  return `breatic:studio-list:${studioId}:${tab}`;
}

/**
 * Read what this browser remembers for a list, keeping only values the list
 * offers. Storage that throws or holds something else reads as nothing.
 * @param studioId - The studio.
 * @param tab - The list.
 * @returns The remembered sort and view, each defaulted.
 */
function read(studioId: string, tab: StudioListTab): { sort: StudioProjectSort; view: ProjectListView } {
  const fallback = { sort: LIST_SORTS[tab][0]!, view: VIEWS[0]! };
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(studioId, tab));
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const value = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    sort: LIST_SORTS[tab].find((s) => s === value.sort) ?? fallback.sort,
    view: VIEWS.find((v) => v === value.view) ?? fallback.view,
  };
}

/**
 * Remember a list's sort and view in this browser, ignoring storage that
 * refuses: the choice still holds for this visit.
 * @param studioId - The studio.
 * @param tab - The list.
 * @param prefs - What to remember.
 * @param prefs.sort - The sort.
 * @param prefs.view - The layout.
 */
function write(
  studioId: string,
  tab: StudioListTab,
  prefs: { sort: StudioProjectSort; view: ProjectListView },
): void {
  try {
    window.localStorage.setItem(storageKey(studioId, tab), JSON.stringify(prefs));
  } catch {
    // A private window or full storage: the choice lasts until the page reloads.
  }
}

/**
 * The sort and layout of one studio's list, remembered in this browser per
 * studio and per list.
 * @param studioId - The studio, by id so a slug change keeps the choice.
 * @param tab - The list.
 * @returns The current sort and view and their setters.
 */
export function useStudioListPrefs(studioId: string, tab: StudioListTab): StudioListPrefs {
  const [prefs, setPrefs] = React.useState(() => read(studioId, tab));
  const [loadedFor, setLoadedFor] = React.useState(`${studioId}:${tab}`);
  if (loadedFor !== `${studioId}:${tab}`) {
    setLoadedFor(`${studioId}:${tab}`);
    setPrefs(read(studioId, tab));
  }

  const setSort = React.useCallback(
    (sort: StudioProjectSort): void => {
      setPrefs((current) => {
        const next = { ...current, sort };
        write(studioId, tab, next);
        return next;
      });
    },
    [studioId, tab],
  );
  const setView = React.useCallback(
    (view: ProjectListView): void => {
      setPrefs((current) => {
        const next = { ...current, view };
        write(studioId, tab, next);
        return next;
      });
    },
    [studioId, tab],
  );

  return React.useMemo(
    () => ({ sort: prefs.sort, view: prefs.view, setSort, setView }),
    [prefs.sort, prefs.view, setSort, setView],
  );
}
