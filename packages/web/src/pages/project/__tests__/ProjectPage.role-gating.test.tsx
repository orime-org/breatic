// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fireEvent,
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
import type { ProjectRole } from '@breatic/shared';

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
      spaces: mockMetaSpaces.current,
      users: new Map(),
      synced: true,
      provider: null,
      status: 'connected' as const,
      authFailedReason: null,
    }),
  };
});

// The Spaces the meta doc lists. Empty for every case but the tab ones; held
// in one object so the array a render reads stays the same between renders.
const mockMetaSpaces: { current: { id: string; name: string; type: 'canvas' }[] } = {
  current: [],
};

// A Space body dials its own document; the tab strip is what these cases read.
vi.mock('@web/pages/project/OpenSpace', () => ({
  OpenSpace: () => null,
}));

// Stub the project-open recorder (fires a fetch on mount otherwise).
vi.mock('@web/pages/project/use-record-project-open', () => ({
  useRecordProjectOpen: () => undefined,
}));

// The leave-guard uses `useBlocker`, which requires a data router; this suite
// renders under a plain MemoryRouter and only exercises role gating, so stub the
// guard out (it has its own dedicated test — LeaveProjectGuard.test.tsx).
vi.mock('@web/pages/project/LeaveProjectGuard', () => ({
  LeaveProjectGuard: () => null,
}));

const getMock = vi.fn();
const membersListMock = vi.fn();
const restoreMock = vi.fn();
vi.mock('@web/data/api', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api')>(
    '@web/data/api',
  );
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: (...a: unknown[]) => getMock(...a),
      restore: (...a: unknown[]) => restoreMock(...a),
    },
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

function setup(
  role: ProjectRole,
  { archivedAt = null, canRestore = false }: { archivedAt?: string | null; canRestore?: boolean } = {},
) {
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
    archivedAt,
    canRestore,
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
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null },
        membershipTier: 'base',
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

describe('ProjectPage — an archived project is read-only for everyone', () => {
  const ARCHIVED = '2026-10-01T00:00:00.000Z';

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('shows the banner and hides what an owner could otherwise write with', async () => {
    setup('owner', { archivedAt: ARCHIVED });
    expect(await screen.findByText('This project is archived and can only be viewed')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-column')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('keeps the real role on the role tag and makes it unclickable', async () => {
    setup('viewer', { archivedAt: ARCHIVED });
    await screen.findByText('This project is archived and can only be viewed');
    const tag = screen.getByTestId('role-tag');
    expect(tag).toHaveTextContent('Viewer');
    expect(tag.tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: /request editor access/i })).toBeNull();
  });

  it('offers restore on the banner to whoever may restore', async () => {
    restoreMock.mockResolvedValue({ ok: true });
    setup('editor', { archivedAt: ARCHIVED, canRestore: true });
    const restore = await screen.findByRole('button', { name: 'Restore' });
    restore.click();
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith(PID));
  });

  it('shows no banner on a live project', async () => {
    setup('owner');
    expect(await screen.findByTestId('agent-column')).toBeInTheDocument();
    expect(screen.queryByText('This project is archived and can only be viewed')).toBeNull();
  });
});

// A viewer cannot rename a Space -- the server refuses it -- so the tab does
// not open its name for editing (inner#956).
describe('ProjectPage — renaming a Space from its tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMetaSpaces.current = [{ id: 'sp1', name: 'Main', type: 'canvas' }];
  });

  afterEach(() => {
    mockMetaSpaces.current = [];
  });

  it('opens the name for an editor', async () => {
    setup('editor');
    fireEvent.doubleClick(await screen.findByTestId('space-tab-name-sp1'));
    expect(screen.getByTestId('space-tab-name-input-sp1')).toBeInTheDocument();
  });

  it('leaves the name closed for a viewer', async () => {
    setup('viewer');
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /request editor access/i }),
      ).toBeInTheDocument();
    });
    fireEvent.doubleClick(await screen.findByTestId('space-tab-name-sp1'));
    expect(screen.queryByTestId('space-tab-name-input-sp1')).toBeNull();
  });
});
