// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Opening a Project by link while it is still being copied (inner#1706 design 5.5, acceptance 2). The page shows only
 * that the Project is being copied and a way back to Studio: it opens no collaboration connection, so no default
 * Space is seeded over the copy, and it records no open, so the copy does not join the Recent page. A copied Project
 * opens as usual.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';

const PID = '11111111-1111-4111-8111-111111111111';
const COPYING_NOTICE = 'This Project is still being copied. Open it from Studio once it\'s done.';

const { metaMock, recordOpenMock } = vi.hoisted(() => ({
  metaMock: vi.fn(),
  recordOpenMock: vi.fn(),
}));

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<typeof import('@web/data/yjs/project-meta')>('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: (...args: unknown[]) => {
      metaMock(...args);
      return {
        spaces: [], users: new Map(), following: new Map(), synced: true, provider: null,
        status: 'connected' as const, authFailedReason: null,
      };
    },
  };
});

vi.mock('@web/pages/project/OpenSpace', () => ({ OpenSpace: () => null }));

vi.mock('@web/pages/project/use-record-project-open', () => ({
  useRecordProjectOpen: (...args: unknown[]) => {
    recordOpenMock(...args);
    return { status: 'idle', refresh: async () => {} };
  },
}));

vi.mock('@web/pages/project/LeaveProjectGuard', () => ({ LeaveProjectGuard: () => null }));

const getMock = vi.fn();
vi.mock('@web/data/api', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api')>('@web/data/api');
  return {
    ...actual,
    projectsApi: { ...actual.projectsApi, get: (...a: unknown[]) => getMock(...a) },
    membersApi: { ...actual.membersApi, list: async () => ({ members: [] }) },
  };
});

import ProjectPage from '@web/pages/project/ProjectPage';

/**
 * Open the Project page at the Project's link.
 * @param copying - Whether the server reads the Project as still being copied.
 */
function openByLink(copying: boolean): void {
  getMock.mockResolvedValue({
    id: PID, name: 'Storyboard copy', description: null, thumbnailUrl: null, createdAt: '', updatedAt: '',
    studioId: 's1', createdByUserId: 'u-me', myRole: 'owner', deletedAt: null, archivedAt: null,
    canManageMeta: true, canRestore: false, canLeave: false, copying,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/project/storyboard-copy-${PID}`]}>
          <Routes>
            <Route path='/project/:projectId' element={<ProjectPage />} />
            <Route path='/studio' element={<p>Studio landing</p>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * Whether any render asked to record this open.
 * @returns True when the recorder was ever enabled.
 */
function recordedAnOpen(): boolean {
  return recordOpenMock.mock.calls.some((call) => call[1] === true);
}

describe('opening a Project that is still being copied', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ chatPanelCollapsed: false });
    useCurrentUserStore.setState({
      user: {
        id: 'u-me', name: 'Me', email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null }, membershipTier: 'base',
      },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('shows only that it is being copied, with a way back to Studio', async () => {
    openByLink(true);
    expect(await screen.findByText(COPYING_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Studio' })).toHaveAttribute('href', '/studio');
    expect(screen.queryByTestId('top-bar')).toBeNull();
  });

  it('opens no collaboration connection and records no open', async () => {
    openByLink(true);
    await screen.findByText(COPYING_NOTICE);
    expect(metaMock).not.toHaveBeenCalled();
    expect(recordedAnOpen()).toBe(false);
  });

  it('opens as usual, and records the open, once it is copied', async () => {
    openByLink(false);
    expect(await screen.findByTestId('top-bar')).toBeInTheDocument();
    expect(screen.queryByText(COPYING_NOTICE)).toBeNull();
    await waitFor(() => expect(recordedAnOpen()).toBe(true));
    expect(metaMock).toHaveBeenCalled();
  });
});
