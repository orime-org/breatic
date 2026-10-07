// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setLocale } from '@breatic/shared';
import type { ProjectSummary, StudioProjectPage } from '@breatic/shared';

import { studiosApi } from '@web/data/api/studios';
import { useStudioProjectsPaging } from '@web/pages/studio/container/use-studio-projects-paging';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: { listProjects: vi.fn() },
}));

const listProjects = vi.mocked(studiosApi.listProjects);

/**
 * A project summary as the API sends it.
 * @param id - Its id.
 * @returns The summary.
 */
function summary(id: string): ProjectSummary {
  return {
    id,
    studioId: 's-1',
    name: id,
    slug: id,
    thumbnailUrl: null,
    myRole: 'owner',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    archivedAt: null,
    lastOpenedAt: null,
    lastEditedAt: new Date('2026-01-01T00:00:00Z'),
    canManageMeta: true,
    canDuplicate: true,
    canArchive: true,
    canRestore: false,
    canLeave: false,
  };
}

/**
 * Render the hook inside a fresh query client.
 * @returns The hook's result and the client.
 */
function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => useStudioProjectsPaging({ slug: 'acme', archived: false, sort: 'opened', enabled: true }),
    { wrapper },
  );
  return { ...hook, client };
}

/** The end-of-list watchers built so far, newest last. */
const observers: Array<{ fire: () => void; disconnected: boolean }> = [];

beforeEach(() => {
  listProjects.mockReset();
  observers.length = 0;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly entry: { fire: () => void; disconnected: boolean };
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        this.entry = { fire: () => callback([{ isIntersecting: true }]), disconnected: false };
        observers.push(this.entry);
      }
      observe(): void {}
      disconnect(): void {
        this.entry.disconnected = true;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale('en');
});

/**
 * Put the hook's refs on a scroll area and an end marker, as the page does.
 * @param result - The hook's result.
 * @param result.current - Its latest value.
 */
function placeRefs(result: { current: ReturnType<typeof useStudioProjectsPaging> }): void {
  const scroller = document.createElement('div');
  const viewport = document.createElement('div');
  viewport.setAttribute('data-radix-scroll-area-viewport', '');
  scroller.append(viewport);
  act(() => {
    result.current.scrollerRef(scroller);
    result.current.sentinelRef(document.createElement('div'));
  });
}

/**
 * Tell the newest live end watcher the end came into view.
 */
function reachEnd(): void {
  const live = observers.filter((o) => !o.disconnected);
  act(() => live[live.length - 1]?.fire());
}

const cursorCalls = (): number => listProjects.mock.calls.filter(([, opts]) => opts.cursor !== undefined).length;

describe('useStudioProjectsPaging', () => {
  it('asks for the first page with the list, sort and no cursor, and reports the total', async () => {
    listProjects.mockResolvedValue({ items: [summary('a')], nextCursor: null, total: 1 });
    const { result } = render();

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(listProjects).toHaveBeenCalledWith('acme', { archived: false, sort: 'opened', cursor: undefined });
    expect(result.current.total).toBe(1);
    expect(result.current.hasNextPage).toBe(false);
  });

  it('joins pages in order and shows a project that moved between pages once', async () => {
    const pages: StudioProjectPage[] = [
      { items: [summary('a'), summary('b')], nextCursor: 'c1', total: 3 },
      { items: [summary('b'), summary('c')], nextCursor: null, total: 3 },
    ];
    listProjects.mockImplementation(async (_slug, opts) => (opts.cursor ? pages[1]! : pages[0]!));
    const { result } = render();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(result.current.projects.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('reports a first page that did not arrive as the first page failing', async () => {
    listProjects.mockRejectedValue(new Error('down'));
    const { result } = render();
    await waitFor(() => expect(result.current.firstPageFailed).toBe(true));
    expect(result.current.projects).toEqual([]);
  });

  it('keeps what it has and reports the next page failing when only that page did not arrive', async () => {
    listProjects.mockImplementation(async (_slug, opts) => {
      if (opts.cursor) throw new Error('down');
      return { items: [summary('a')], nextCursor: 'c1', total: 2 };
    });
    const { result } = render();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.pageFailed).toBe(true));
    expect(result.current.firstPageFailed).toBe(false);
    expect(result.current.projects.map((p) => p.id)).toEqual(['a']);
  });

  it('asks for the next page when the end comes into view', async () => {
    listProjects.mockImplementation(async (_slug, opts) =>
      opts.cursor
        ? { items: [summary('b')], nextCursor: null, total: null }
        : { items: [summary('a')], nextCursor: 'c1', total: 2 },
    );
    const { result } = render();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    placeRefs(result);

    reachEnd();

    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(['a', 'b']));
    expect(result.current.total).toBe(2);
  });

  it('refetches every loaded page after an invalidation, keeping the projects and total on screen, and does not page meanwhile', async () => {
    let release: () => void = () => {};
    let holdRefetch = false;
    listProjects.mockImplementation(async (_slug, opts) => {
      if (!opts.cursor) {
        if (holdRefetch) await new Promise<void>((r) => { release = r; });
        return { items: [summary('a')], nextCursor: 'c1', total: 3 };
      }
      if (opts.cursor === 'c1') return { items: [summary('b')], nextCursor: 'c2', total: null };
      return { items: [summary('c')], nextCursor: null, total: null };
    });
    const { result, client } = render();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    placeRefs(result);
    const before = listProjects.mock.calls.length;
    const cursorsBefore = cursorCalls();

    holdRefetch = true;
    act(() => {
      void client.invalidateQueries();
    });
    await waitFor(() => expect(listProjects.mock.calls.length).toBe(before + 1));
    // The refetch is out: the list stays, and the end in view asks for nothing.
    expect(result.current.projects.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.total).toBe(3);
    reachEnd();
    expect(cursorCalls()).toBe(cursorsBefore);

    act(() => release());
    await waitFor(() => expect(listProjects.mock.calls.length).toBe(before + 2));
    expect(listProjects.mock.calls.slice(before).map(([, opts]) => opts.cursor)).toEqual([undefined, 'c1']);
    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(['a', 'b']));
  });

  it('asks for the first page again when the interface language changes', async () => {
    listProjects.mockResolvedValue({ items: [summary('a')], nextCursor: null, total: 1 });
    const { result } = render();
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    const before = listProjects.mock.calls.length;

    act(() => setLocale('zh-CN'));

    await waitFor(() => expect(listProjects.mock.calls.length).toBe(before + 1));
    expect(listProjects.mock.calls[before]?.[1]).toEqual({ archived: false, sort: 'opened', cursor: undefined });
  });
});
