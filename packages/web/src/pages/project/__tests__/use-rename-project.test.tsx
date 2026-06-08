// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/projects', () => ({
  projectsApi: { rename: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
import { projectsApi } from '@web/data/api/projects';
import { toast } from 'sonner';
import { t } from '@breatic/shared';
import {
  isStudioProjectsListKey,
  useRenameProject,
} from '@web/pages/project/use-rename-project';

// ── pure predicate (the matching logic the bug got wrong) ──────────────────
describe('isStudioProjectsListKey (spec: studio container projects list key)', () => {
  it('matches a studio projects-list key ["studio", <slug>, "projects"]', () => {
    expect(isStudioProjectsListKey(['studio', 'acme', 'projects'])).toBe(true);
    expect(isStudioProjectsListKey(['studio', 'alex', 'projects'])).toBe(true);
  });

  it('rejects the studio detail key, member list and unrelated keys', () => {
    expect(isStudioProjectsListKey(['studio', 'acme'])).toBe(false);
    expect(isStudioProjectsListKey(['studio', 'acme', 'members'])).toBe(false);
    expect(isStudioProjectsListKey(['project', 'p1'])).toBe(false);
    expect(isStudioProjectsListKey(['projects', 'list'])).toBe(false);
    expect(isStudioProjectsListKey([])).toBe(false);
  });
});

// ── reproduction: rename must invalidate the studio projects list ──────────
function makeWrapper(client: QueryClient) {
  return function Wrapper({
    children,
  }: {
    children: React.ReactNode;
  }): React.JSX.Element {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.rename).mockResolvedValue({
    id: 'p1',
    studioId: 's1',
    createdByUserId: 'u1',
    name: 'New Name',
    description: null,
    thumbnailUrl: null,
    myRole: 'owner',
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    deletedAt: null,
  });
});

describe('useRenameProject (#1068: rename refreshes the studio list)', () => {
  it('invalidates the studio container projects list after a rename', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The studio container lists projects under ['studio', slug, 'projects'].
    // Seed it as a settled (non-stale) query so we can prove the rename
    // invalidates it. Without the fix the rename only touched the dead
    // ['projects','list'] key, leaving this one stale-but-not-invalidated.
    client.setQueryData(['studio', 's1', 'projects'], []);
    client.setQueryData(['project', 'p1'], { name: 'Old Name' });

    const { result } = renderHook(() => useRenameProject('p1'), {
      wrapper: makeWrapper(client),
    });

    act(() => {
      result.current.mutate('New Name');
    });

    await waitFor(() => {
      expect(
        client.getQueryState(['studio', 's1', 'projects'])?.isInvalidated,
      ).toBe(true);
    });
    // The in-project detail is refreshed too.
    expect(client.getQueryState(['project', 'p1'])?.isInvalidated).toBe(true);
    expect(vi.mocked(projectsApi.rename)).toHaveBeenCalledWith('p1', 'New Name');
  });

  it('optimistically updates the project name before the request resolves', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(['project', 'p1'], { name: 'Old Name' });

    const { result } = renderHook(() => useRenameProject('p1'), {
      wrapper: makeWrapper(client),
    });

    act(() => {
      result.current.mutate('New Name');
    });

    // Optimistic write lands synchronously in onMutate.
    await waitFor(() => {
      expect(
        (client.getQueryData(['project', 'p1']) as { name: string }).name,
      ).toBe('New Name');
    });
  });

  it('shows an i18n toast (not a hardcoded English string) and rolls back on failure (#1091)', async () => {
    vi.mocked(projectsApi.rename).mockRejectedValueOnce(new Error('boom'));
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    client.setQueryData(['project', 'p1'], { name: 'Old Name' });

    const { result } = renderHook(() => useRenameProject('p1'), {
      wrapper: makeWrapper(client),
    });

    act(() => {
      result.current.mutate('New Name');
    });

    // onError fires: a toast is shown and the optimistic name is rolled back.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });

    // The toast title must go through the i18n engine — not the old hardcoded
    // English literal 'Project rename failed' (#1091).
    const [title, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(title).toBe(t('project.header.renameFailed'));
    expect(title).not.toBe('Project rename failed');
    // The error detail is surfaced as the toast description.
    expect((opts as { description?: string } | undefined)?.description).toBe(
      'boom',
    );
    // Optimistic update rolled back to the previous name.
    expect(
      (client.getQueryData(['project', 'p1']) as { name: string }).name,
    ).toBe('Old Name');
  });
});
