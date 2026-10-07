// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
 * @returns The hook's result.
 */
function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => useStudioProjectsPaging({ slug: 'acme', archived: false, sort: 'opened', enabled: true }),
    { wrapper },
  );
}

beforeEach(() => {
  listProjects.mockReset();
});

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
});
