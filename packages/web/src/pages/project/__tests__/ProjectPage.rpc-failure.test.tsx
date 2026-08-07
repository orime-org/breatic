// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every way a Space RPC can fail has to reach the user.
 *
 * `callRpc` is the one place all six Space operations go through, and every
 * caller ends in `.catch(() => {})` with a comment saying the toast has
 * already been shown. That is only true if `callRpc` really does show one on
 * every failure path, so this file pins that promise.
 *
 * There are three ways to fail, and the third is the one a real-browser smoke
 * caught: `sendSpaceRpc` rejects on its own 10s timeout, and on anything the
 * transport throws. That rejection used to travel straight out of the `await`,
 * past the toast, into a caller's empty catch — so with the network down, a
 * user could close a tab and get no answer at all, ever. Design §6.6.2 says a
 * failed close pops a toast and moves nothing; the toast half was missing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  waitFor,
  act,
  fireEvent,
  type RenderOptions,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { toast } from '@web/lib/toast';

const PID = '11111111-1111-4111-8111-111111111111';
const SPACE_A = '22222222-2222-4222-8222-222222222222';
const SPACE_B = '33333333-3333-4333-8333-333333333333';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

/**
 * Stands in for a mounted provider. `callRpc` only checks it is non-null, but
 * the activity panel subscribes to `stateless` on it, so it needs the two
 * listener methods to mount at all.
 */
const fakeProvider = { on: (): void => {}, off: (): void => {} } as never;

/**
 * The live spaces list, mutable so a case can land the broadcast that a
 * create is waiting for. Re-rendering is triggered separately through the
 * zustand store the page already subscribes to.
 */
const meta: {
  spaces: Array<{
    id: string;
    name: string;
    type: 'document';
    claimToken?: string;
  }>;
} = {
  spaces: [
    { id: SPACE_A, name: 'Space A', type: 'document' },
    { id: SPACE_B, name: 'Space B', type: 'document' },
  ],
};

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/project-meta')
      >('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: (): ReturnType<
      typeof import('@web/data/yjs/project-meta').useProjectMeta
    > => ({
      spaces: meta.spaces,
      openTabIds: [SPACE_A, SPACE_B],
      users: new Map(),
      synced: true,
      provider: fakeProvider,
      status: 'connected',
      authFailedReason: null,
    }),
  };
});

const sendSpaceRpcMock = vi.fn();
vi.mock('@web/data/yjs/space-rpc-client', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/space-rpc-client')
      >('@web/data/yjs/space-rpc-client');
  return {
    ...actual,
    sendSpaceRpc: (...a: unknown[]) => sendSpaceRpcMock(...a),
  };
});

vi.mock('@web/pages/project/use-record-project-open', () => ({
  useRecordProjectOpen: (): undefined => undefined,
}));

vi.mock('@web/pages/project/LeaveProjectGuard', () => ({
  LeaveProjectGuard: (): null => null,
}));

vi.mock('@web/pages/project/SpaceOutlet', () => ({
  SpaceOutlet: (): null => null,
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
 * Render the project page with two open tabs and a mounted provider.
 */
function setup(): void {
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

describe('ProjectPage — a failed Space RPC always says so', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    meta.spaces = [
      { id: SPACE_A, name: 'Space A', type: 'document' },
      { id: SPACE_B, name: 'Space B', type: 'document' },
    ];
    useUIStore.setState({ chatPanelCollapsed: true, spaceOpInProgress: null });
    useCurrentUserStore.setState({
      user: {
        id: 'u-me',
        name: 'Me',
        email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null },
      },
    });
  });

  it('a rejected request (timeout, transport error) still shows a toast', async () => {
    sendSpaceRpcMock.mockRejectedValue(
      new Error('Space RPC timeout for type=tab:close (id=x, 10000ms)'),
    );
    setup();

    const closeB = await screen.findByTestId(`space-tab-close-${SPACE_B}`);
    closeB.click();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });

    // Asserting the TRANSLATED strings, not the keys. A key with no entry in
    // the catalogue falls back to the key itself, so this also pins that both
    // of these exist in `locales/` — `project.space.error.closeTab` shipped
    // without one and nothing caught it (no guard runs in this direction, and
    // the key is not written inside a `t()` call for a scanner to find; see
    // task #45).
    const [title, opts] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(title).toBe('Failed to close the tab');
    expect((opts as { description?: string } | undefined)?.description).toBe(
      'No answer from the server — check your connection and try again',
    );
  });

  it('a request the server refuses shows exactly one toast, not two', async () => {
    // The refusal path had its own toast already. Adding one for rejections
    // must not double up on this one.
    sendSpaceRpcMock.mockResolvedValue({
      id: 'r1',
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Role viewer cannot close' },
    });
    setup();

    const closeB = await screen.findByTestId(`space-tab-close-${SPACE_B}`);
    closeB.click();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
  });

  it('a create that lands but whose tab:open fails names the RIGHT operation', async () => {
    // Two separate round trips: the Space is created and broadcast, then its
    // tab is opened. If the second one fails the Space still exists and is
    // already in the list, so telling the user the CREATE failed sends them
    // off to make a second one.
    let capturedToken: string | undefined;
    sendSpaceRpcMock.mockImplementation(
      async (_provider: unknown, req: { type: string; payload: Record<string, unknown> }) => {
        if (req.type === 'space:create') {
          capturedToken = req.payload.claimToken as string;
          // The broadcast lands: the entry shows up carrying our token.
          meta.spaces = [
            ...meta.spaces,
            {
              id: '44444444-4444-4444-8444-444444444444',
              name: 'Fresh',
              type: 'document',
              claimToken: capturedToken,
            },
          ];
          return { id: 'r1', ok: true, data: {} };
        }
        throw new Error('Space RPC timeout for type=tab:open (id=x, 10000ms)');
      },
    );
    setup();

    (await screen.findByTestId('new-space-button')).click();
    (await screen.findByRole('radio', { name: /Document/ })).click();
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Fresh' },
    });
    (await screen.findByRole('button', { name: 'Create' })).click();

    // The create resolved and mutated `meta.spaces`; nudge a re-render so the
    // claim effect sees the new entry and fires its tab:open.
    await waitFor(() => expect(capturedToken).toBeDefined());
    act(() => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(
      'Failed to open the tab',
    );
  });

  it('switching to an already-open tab sends NO RPC at all (§6.6.2)', async () => {
    // Which tab is active is local window state; the design says a pure
    // switch never rides the wire — only opening one MORE tab or closing
    // one does. Firing tab:open on every click meant that with collab
    // unreachable, a switch that visibly succeeded raised "failed to open
    // the tab" ten seconds later, on every switch.
    sendSpaceRpcMock.mockResolvedValue({ id: 'r1', ok: true, data: {} });
    setup();

    const tabB = await screen.findByTestId(`space-tab-${SPACE_B}`);
    tabB.click();

    await waitFor(() => {
      expect(tabB.getAttribute('aria-selected')).toBe('true');
    });
    expect(sendSpaceRpcMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a request that succeeds says nothing', async () => {
    sendSpaceRpcMock.mockResolvedValue({ id: 'r1', ok: true, data: {} });
    setup();

    const closeB = await screen.findByTestId(`space-tab-close-${SPACE_B}`);
    closeB.click();

    await waitFor(() => {
      expect(sendSpaceRpcMock).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
