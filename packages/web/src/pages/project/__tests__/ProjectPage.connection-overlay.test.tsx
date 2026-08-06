// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The workspace overlay must appear for every connection state the banner
 * covers.
 *
 * `ConnectionBanner` documents the two as a pair ("both must appear / disappear
 * on the same frame, otherwise the staggered timing reads as visual jitter"),
 * but the overlay only ever mounted for `authFailed` while the banner also
 * shows for `disconnected`. Appearing together is what these tests pin.
 *
 * What the overlay is FOR: telling the user something is wrong. Once it is on
 * screen the user knows, and that is the end of the requirement. Being opaque
 * it does also swallow clicks — a side effect of covering the screen, not a
 * goal — and no work goes into either blocking input more thoroughly or
 * letting it through. A state where the user has already been told something is
 * broken is not a state worth polishing (user 2026-08-02).
 *
 * What DOES get work is not reaching into the rest of the app: an earlier
 * version marked the workspace `inert`, which pulled focus out of the editor
 * and cut off in-flight IME composition. That is the rule this file still
 * guards — show the problem where it is, change nothing else (decision
 * 2026-08-02).
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
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null },
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

  it('does not reach into the workspace to disable it', async () => {
    // Not the same claim as "the workspace is still usable" — it is not, the
    // opaque curtain is on top of it. What is pinned here is that nothing
    // reaches INTO the workspace to disable it: `inert` stops the whole subtree
    // receiving input, which pulls focus out of whatever the user was typing in
    // and kills IME composition mid-word, and `aria-hidden` erases the subtree
    // for a screen reader. The curtain takes the pointer and leaves the
    // keyboard, so someone already typing carries on; both of these took that
    // away too, for a requirement the curtain already meets by being visible.
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
