// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

// A concrete uuid so `projectUuidFromRouteParam` extracts it and the
// project query runs (the `demo` short-circuit disables it).
const PID = '11111111-1111-4111-8111-111111111111';

// Mock the heavy Yjs / socket meta hook so ProjectPage renders past the
// `connecting` loading gate deterministically (real useSocket dials a WS).
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

// Stub the project-open recorder (fires a fetch on mount otherwise).
vi.mock('@web/pages/project/use-record-project-open', () => ({
  useRecordProjectOpen: () => undefined,
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

function setup(role: ProjectRole) {
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

describe('ProjectPage — agent-column role gating (B model — hide)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ chatPanelCollapsed: false });
    useCurrentUserStore.setState({
      user: {
        id: 'u-me',
        name: 'Me',
        email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me' },
      },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('owner sees the agent column', async () => {
    setup('owner');
    expect(await screen.findByTestId('agent-column')).toBeInTheDocument();
  });

  it('editor sees the agent column', async () => {
    setup('editor');
    expect(await screen.findByTestId('agent-column')).toBeInTheDocument();
  });

  it('viewer does NOT see the agent column', async () => {
    setup('viewer');
    await screen.findByTestId('top-bar');
    // The project query resolves async; the page renders with the
    // `owner` fail-open default first, then re-renders as `viewer`.
    // Once the viewer role tag (the clickable request-access chip)
    // lands, the agent column must be gone.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /request editor access/i }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId('agent-column')).toBeNull();
  });
});
