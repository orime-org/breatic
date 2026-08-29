// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  waitFor,
  type RenderOptions,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import type { ProjectRole } from '@web/stores';
import { PAGE_MIN_WIDTH } from '@web/pages/project/agent-column-width';

const PID = '11111111-1111-4111-8111-111111111111';

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/project-meta')
      >('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: () => ({
      spaces: [],
      openTabIds: [],
      users: new Map(),
      synced: true,
      provider: null,
      status: 'connected' as const,
      authFailedReason: null,
    }),
  };
});

vi.mock('@web/pages/project/use-record-project-open', () => ({
  useRecordProjectOpen: () => undefined,
}));

vi.mock('@web/pages/project/LeaveProjectGuard', () => ({
  LeaveProjectGuard: () => null,
}));

const getMock = vi.fn();
const membersListMock = vi.fn();
vi.mock('@web/data/api', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api')>(
    '@web/data/api',
  );
  return {
    ...actual,
    projectsApi: { ...actual.projectsApi, get: (...a: unknown[]) => getMock(...a) },
    membersApi: {
      ...actual.membersApi,
      list: (...a: unknown[]) => membersListMock(...a),
    },
  };
});

import ProjectPage from '@web/pages/project/ProjectPage';

function AllProviders({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

const render = (ui: React.ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: AllProviders, ...options });

function setup(role: ProjectRole): void {
  getMock.mockResolvedValue({
    id: PID,
    name: 'Demo project',
    description: null,
    thumbnailUrl: null,
    createdAt: '',
    updatedAt: '',
    studioId: 's1',
    createdByUserId: 'u-me',
    myRole: role,
    deletedAt: null,
  });
  membersListMock.mockResolvedValue({ members: [] });
  render(
    <MemoryRouter initialEntries={[`/project/demo-${PID}`]}>
      <Routes>
        <Route path='/project/:projectId' element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProjectPage — the two columns and the handle between them', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useUIStore.setState({ chatPanelCollapsed: false });
    useCurrentUserStore.setState({
      user: {
        id: 'u-me',
        name: 'Me',
        email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null },
        membershipTier: 'base',
      },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('renders a drag handle beside the Agent column', async () => {
    setup('owner');
    await screen.findByTestId('agent-column');
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('takes the handle away with the column when it is collapsed', async () => {
    useUIStore.setState({ chatPanelCollapsed: true });
    setup('owner');
    await screen.findByTestId('top-bar');

    expect(screen.queryByTestId('agent-column')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('takes the handle away with the column for a viewer', async () => {
    setup('viewer');
    await screen.findByTestId('top-bar');
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /request editor access/i }),
      ).toBeInTheDocument();
    });

    expect(screen.queryByTestId('agent-column')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('holds the page at its floor so neither side is squeezed past its minimum', async () => {
    setup('owner');
    const page = await screen.findByTestId('project-page');
    expect(page.style.minWidth).toBe(`${PAGE_MIN_WIDTH}px`);
  });

  it('keeps that floor when the column is collapsed', async () => {
    useUIStore.setState({ chatPanelCollapsed: true });
    setup('owner');
    const page = await screen.findByTestId('project-page');
    expect(page.style.minWidth).toBe(`${PAGE_MIN_WIDTH}px`);
  });
});
