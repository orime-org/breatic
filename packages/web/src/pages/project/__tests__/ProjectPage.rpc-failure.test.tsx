// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * past the toast, into a caller's empty catch — so with the network down, an
 * operation could get no answer at all, ever.
 *
 * Creating a Space is the trigger here because it is the one Space operation
 * a click can reach from a rendered tab bar. The tab bar itself no longer
 * rides the wire at all (task #2144), which is what the last two cases pin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  waitFor,
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
        membershipTier: 'base',
      },
    });
  });

  /**
   * Walk the create dialog, the one Space RPC a click reaches from here.
   * @returns once the request has been sent.
   */
  async function createSpace(): Promise<void> {
    (await screen.findByTestId('new-space-button')).click();
    (await screen.findByRole('radio', { name: /Document/ })).click();
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'New one' },
    });
    (await screen.findByRole('button', { name: 'Create' })).click();
  }

  it('a rejected request (timeout, transport error) still shows a toast', async () => {
    sendSpaceRpcMock.mockRejectedValue(
      new Error('Space RPC timeout for type=space:create (id=x, 10000ms)'),
    );
    setup();

    await createSpace();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });

    // Asserting the TRANSLATED strings, not the keys. A key with no entry in
    // the catalogue falls back to the key itself, so this also pins that both
    // of these exist in `locales/` — one of these keys shipped without one and
    // nothing caught it (no guard runs in this direction, and the key is not
    // written inside a `t()` call for a scanner to find; see task #45).
    const [title, opts] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(title).toBe('Failed to create space');
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
      error: { code: 'FORBIDDEN', message: 'Role viewer cannot create' },
    });
    setup();

    await createSpace();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
  });

  it('clicking a tab sends no RPC at all', async () => {
    // The whole tab bar is runtime state of this browser tab now, so opening
    // one, switching to one and closing one are all instant and local. They
    // used to be round trips, and with collab unreachable a switch that
    // visibly succeeded raised "failed to open the tab" ten seconds later.
    sendSpaceRpcMock.mockResolvedValue({ id: 'r1', ok: true, data: {} });
    setup();

    const drawer = await screen.findByTestId('space-drawer-trigger');
    drawer.click();
    const row = await screen.findByTestId(`space-drawer-row-${SPACE_A}`);
    (row.querySelector('button') as HTMLButtonElement).click();

    const tabA = await screen.findByTestId(`space-tab-${SPACE_A}`);
    await waitFor(() => {
      expect(tabA.getAttribute('aria-selected')).toBe('true');
    });
    (await screen.findByTestId(`space-tab-close-${SPACE_A}`)).click();
    await waitFor(() => {
      expect(screen.queryByTestId(`space-tab-${SPACE_A}`)).toBeNull();
    });

    expect(sendSpaceRpcMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a request that succeeds says nothing', async () => {
    sendSpaceRpcMock.mockResolvedValue({ id: 'r1', ok: true, data: {} });
    setup();

    await createSpace();

    await waitFor(() => {
      expect(sendSpaceRpcMock).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
