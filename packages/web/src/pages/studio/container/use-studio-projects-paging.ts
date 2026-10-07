// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getLocale } from '@breatic/shared';
import type { ProjectSummary, StudioProjectPage, StudioProjectSort } from '@breatic/shared';

import { studioProjectsListKey } from '@web/data/api/projects';
import { studiosApi } from '@web/data/api/studios';
import { useTranslation } from '@web/i18n/use-translation';
import { useScrolledToEnd } from '@web/lib/use-scrolled-to-end';
import type { ContainerProject } from '@web/pages/studio/container/container-types';

/** What a studio's projects list renders from. */
export interface StudioProjectList {
  /** Every project loaded so far, in the list's order, each once. */
  projects: readonly ContainerProject[];
  /** How many projects the whole list holds; null until the first page arrives. */
  total: number | null;
  /** The first page has not arrived. */
  isPending: boolean;
  /** Nothing has arrived and the first page did not come. */
  firstPageFailed: boolean;
  /** Ask for the first page again. */
  retryFirstPage: () => void;
  /** A further page is on its way. */
  isFetchingNextPage: boolean;
  /** There are more pages to read. */
  hasNextPage: boolean;
  /** Projects are in hand and the page after them did not come. */
  pageFailed: boolean;
  /** Ask for the next page. */
  loadMore: () => void;
  /** Goes on an empty element after the last project. */
  sentinelRef: (node: HTMLElement | null) => void;
  /** Goes on the element wrapping the `ScrollArea` the list scrolls in. */
  scrollerRef: (node: HTMLElement | null) => void;
}

/**
 * Map a project summary from the API onto the card's view model. Times arrive
 * as JSON strings and are normalised to ISO strings.
 * @param p - The summary from `GET /studio/:slug/projects`.
 * @returns The card view model.
 */
export function toContainerProject(p: ProjectSummary): ContainerProject {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    thumbnailUrl: p.thumbnailUrl,
    myRole: p.myRole,
    createdAt: new Date(p.createdAt).toISOString(),
    archivedAt: p.archivedAt === null ? null : new Date(p.archivedAt).toISOString(),
    lastOpenedAt: p.lastOpenedAt === null ? null : new Date(p.lastOpenedAt).toISOString(),
    lastEditedAt: new Date(p.lastEditedAt).toISOString(),
    canManageMeta: p.canManageMeta,
    canDuplicate: p.canDuplicate,
    canArchive: p.canArchive,
    canRestore: p.canRestore,
    canLeave: p.canLeave,
  };
}

/**
 * Read a studio's projects list one page at a time, fetching the next as the
 * reader nears the end of the page's scroll area.
 *
 * The query key carries the interface language, because names sort by it.
 * Pages are joined dropping any project already shown: a project another
 * member renamed or edited between two pages can come back in a later one.
 * The next page is asked for only while nothing else is in flight: a refetch
 * clears the failure flag the moment it starts, and asking for the next page
 * then would cancel that refetch.
 * @param options - Which list and how it is sorted.
 * @param options.slug - The studio's URL handle.
 * @param options.archived - The archived list instead of the live one.
 * @param options.sort - The sort.
 * @param options.enabled - Whether to read at all.
 * @returns The list state and the two refs to place.
 */
export function useStudioProjectsPaging({
  slug,
  archived,
  sort,
  enabled,
}: {
  slug: string;
  archived: boolean;
  sort: StudioProjectSort;
  enabled: boolean;
}): StudioProjectList {
  // Subscribes to language changes, so the key below follows them.
  useTranslation();
  const locale = getLocale();
  const query = useInfiniteQuery({
    queryKey: studioProjectsListKey(slug, { archived, sort, locale }),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      studiosApi.listProjects(slug, { archived, sort, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: StudioProjectPage) => last.nextCursor ?? undefined,
    enabled,
  });

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    isError,
    isPending,
    refetch,
  } = query;

  const projects = React.useMemo(() => {
    const seen = new Set<string>();
    const out: ContainerProject[] = [];
    for (const page of data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(toContainerProject(item));
      }
    }
    return out;
  }, [data]);

  const loadMore = React.useCallback((): void => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const retryFirstPage = React.useCallback((): void => {
    void refetch();
  }, [refetch]);

  const { scrollerRef, sentinelRef } = useScrolledToEnd({
    enabled: hasNextPage && !isFetching,
    onReachEnd: loadMore,
    itemCount: projects.length,
    failed: isFetchNextPageError,
  });

  const total = data?.pages[0]?.total ?? null;
  return React.useMemo(
    () => ({
      projects,
      total,
      isPending: enabled && isPending,
      firstPageFailed: isError && data === undefined,
      retryFirstPage,
      isFetchingNextPage,
      hasNextPage,
      pageFailed: isFetchNextPageError,
      loadMore,
      sentinelRef,
      scrollerRef,
    }),
    [
      projects,
      total,
      enabled,
      isPending,
      isError,
      data,
      retryFirstPage,
      isFetchingNextPage,
      hasNextPage,
      isFetchNextPageError,
      loadMore,
      sentinelRef,
      scrollerRef,
    ],
  );
}
