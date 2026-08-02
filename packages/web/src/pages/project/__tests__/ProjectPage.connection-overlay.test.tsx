// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The workspace overlay must appear for every connection state the banner
 * covers — and must not do anything beyond appearing.
 *
 * `ConnectionBanner` documents the two as a pair ("both must appear / disappear
 * on the same frame, otherwise the staggered timing reads as visual jitter"),
 * but the overlay only ever mounted for `authFailed` while the banner also
 * shows for `disconnected`.
 *
 * What the overlay is FOR: telling the user something is wrong. Not blocking
 * input. Showing the problem where it is and leaving everything else working is
 * the rule (decision 2026-08-02) — a page that still responds tells the user
 * the fault is not on their side, while a page that goes dead tells them only
 * that something broke. An earlier version of this file marked the workspace
 * `inert`, which pulled focus out of the editor and cut off in-flight IME
 * composition: a real cost paid for a goal that was never the point.
 */

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
import type { ConnectionStatus } from '@web/data/yjs/use-socket';

const PID = '11111111-1111-4111-8111-111111111111';

/** Mutable so each case can put the socket in a different state. */
const socket: { status: ConnectionStatus } = { status: 'connected' };

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/project-meta')
      >('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: (): ReturnType<
      typeof import('@web/data/yjs/project-meta').useProjectMeta
    > => ({
      spaces: [],
      openTabIds: [],
      users: new Map(),
      onlineUserIds: new Set<string>(),
      synced: true,
      provider: null,
      status: socket.status,
      authFailedReason: null,
    }),
  };
});

vi.mock('@web/pages/project/use-record-project-open', () => ({
  useRecordProjectOpen: (): undefined => undefined,
}));

vi.mock('@web/pages/project/LeaveProjectGuard', () => ({
  LeaveProjectGuard: (): null => null,
}));

const getMock = vi.fn();
const membersListMock = vi.fn();
vi.mock('@web/data/api', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api')>(
    '@web/data/api',
  );
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: (...a: unknown[]) => getMock(...a),
    },
    membersApi: {
      ...actual.membersApi,
      list: (...a: unknown[]) => membersListMock(...a),
    },
  };
});

import ProjectPage from '@web/pages/project/ProjectPage';

/**
 * Wraps the page in the providers it needs.
 * @param root0 - Component props.
 * @param root0.children - Subtree to wrap.
 * @returns The wrapped subtree.
 */
function AllProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
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

/**
 * Render the project page with the socket in the given connection state.
 * @param status - Connection status the meta hook reports.
 */
function setup(status: ConnectionStatus): void {
  socket.status = status;
  getMock.mockResolvedValue({
    id: PID,
    name: 'Demo project',
    description: null,
    thumbnailUrl: null,
    createdAt: '',
    updatedAt: '',
    studioId: 's1',
    createdByUserId: 'u-me',
    myRole: 'owner',
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

describe('ProjectPage — the workspace overlay follows the banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ chatPanelCollapsed: false });
    useCurrentUserStore.setState({
      user: {
        id: 'u-me',
        name: 'Me',
        email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me' },
      } as ReturnType<typeof useCurrentUserStore.getState>['user'],
      role: null,
      loading: false,
      bootstrapped: true,
    });
    socket.status = 'connected';
  });

  it('leaves the workspace usable while connected', async () => {
    setup('connected');
    await waitFor(() =>
      expect(screen.queryByTestId('connection-banner')).toBeNull(),
    );
    expect(screen.queryByTestId('workspace-disabled-overlay')).toBeNull();
  });

  it('covers the workspace when the session has expired', async () => {
    setup('authFailed');
    await screen.findByTestId('connection-banner');
    expect(
      screen.getByTestId('workspace-disabled-overlay'),
    ).toBeInTheDocument();
  });

  it('covers the workspace when the connection has dropped', async () => {
    // Same signal as an expired session, through the same overlay rather than a
    // second mechanism of its own.
    setup('disconnected');
    await screen.findByTestId('connection-banner');
    expect(
      screen.getByTestId('workspace-disabled-overlay'),
    ).toBeInTheDocument();
  });

  it('does NOT disable the workspace it covers', async () => {
    // The curtain is paint. Disabling the workspace as well would take away the
    // one thing that tells the user where the fault is: a page that still
    // responds says "not your side". `inert` in particular also pulls focus out
    // of whatever they were typing in and kills IME composition mid-word.
    //
    // Selected by a data attribute present in BOTH states, so the assertion
    // cannot pass vacuously by matching nothing.
    setup('disconnected');
    await screen.findByTestId('workspace-disabled-overlay');
    const workspace = document.querySelector('[data-workspace]');
    expect(workspace).not.toBeNull();
    expect(workspace?.hasAttribute('inert')).toBe(false);
    expect(workspace?.getAttribute('aria-hidden')).toBeNull();
  });
});
