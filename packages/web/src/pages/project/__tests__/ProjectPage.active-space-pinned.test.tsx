// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which Space the page shows survives a change to the tab ORDER.
 *
 * Opening a project leaves `activeSpaceId` null, and
 * `resolveEffectiveActiveSpace` answers that with the first open tab — by
 * position. Reordering tabs changes which tab is first, so a user who has
 * never clicked one would have the body swapped out from under them by a
 * drag, and a second connection on the same account could do it remotely.
 * That is exactly what moving the active tab out of the shared doc
 * (2026-07-11) set out to stop.
 *
 * So the page pins the effective active Space the moment tabs first exist:
 * from then on it is a choice by id, and position cannot move it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  act,
  type RenderOptions,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';

const PID = '11111111-1111-4111-8111-111111111111';
const SPACE_A = '22222222-2222-4222-8222-222222222222';
const SPACE_B = '33333333-3333-4333-8333-333333333333';
const SPACE_C = '44444444-4444-4444-8444-444444444444';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

/** Stands in for a mounted provider; the activity panel subscribes to it. */
const fakeProvider = { on: (): void => {}, off: (): void => {} } as never;

const meta: {
  spaces: Array<{ id: string; name: string; type: 'document' }>;
  openTabIds: readonly string[];
} = {
  spaces: [
    { id: SPACE_A, name: 'Space A', type: 'document' },
    { id: SPACE_B, name: 'Space B', type: 'document' },
  ],
  openTabIds: [SPACE_A, SPACE_B],
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
      openTabIds: meta.openTabIds,
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

/**
 * Every mount of the Space body, in order. The page keys `SpaceOutlet` on
 * the active Space's id, so a changed key shows up here as a second entry —
 * which is what "the body was remounted" means for the running Space.
 */
const outletMounts = vi.hoisted(() => [] as string[]);
vi.mock('@web/pages/project/SpaceOutlet', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    SpaceOutlet: ({ spaceId }: { spaceId: string }): null => {
      react.useEffect(() => {
        outletMounts.push(spaceId);
      }, [spaceId]);
      return null;
    },
  };
});

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
 * Render the project page.
 * @returns Nothing.
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

/**
 * Hand the page a new tab order, the way a broadcast would.
 * @param order - The open-tab ids the server now says this user has.
 * @returns Resolves once the page has re-rendered against the new list.
 */
async function landOrder(order: readonly string[]): Promise<void> {
  meta.openTabIds = order;
  await act(async () => {
    useUIStore.setState({
      chatPanelCollapsed: !useUIStore.getState().chatPanelCollapsed,
    });
  });
}

/**
 * The id of the tab currently marked selected in the tab bar.
 * @returns That Space's id, or null when no tab is selected.
 */
function selectedTabId(): string | null {
  const tab = screen.queryByRole('tab', { selected: true });
  const testId = tab?.getAttribute('data-testid') ?? null;
  return testId ? testId.replace('space-tab-', '') : null;
}

describe('ProjectPage — reordering tabs does not change which Space is shown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outletMounts.length = 0;
    meta.spaces = [
      { id: SPACE_A, name: 'Space A', type: 'document' },
      { id: SPACE_B, name: 'Space B', type: 'document' },
    ];
    meta.openTabIds = [SPACE_A, SPACE_B];
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

  it('keeps the shown Space when a user who never clicked a tab reorders', async () => {
    setup();
    expect(await screen.findByTestId(`space-tab-${SPACE_A}`)).toBeTruthy();
    expect(selectedTabId()).toBe(SPACE_A);

    // The drag lands: B is first now. Nothing about which Space is open
    // changed, so the body must not move.
    await landOrder([SPACE_B, SPACE_A]);

    expect(selectedTabId()).toBe(SPACE_A);
  });

  it('does not remount the Space body when the order changes', async () => {
    // The body is keyed on the active Space's id, and a remount re-runs
    // fitView and throws away whatever the Space had running. Reordering
    // tabs says nothing about which Space is open, so nothing may remount.
    setup();
    expect(await screen.findByTestId(`space-tab-${SPACE_A}`)).toBeTruthy();
    expect(outletMounts).toEqual([SPACE_A]);

    await landOrder([SPACE_B, SPACE_A]);

    expect(outletMounts).toEqual([SPACE_A]);
  });

  it('keeps a tab the user did click, through a reorder', async () => {
    setup();
    const tabB = await screen.findByTestId(`space-tab-${SPACE_B}`);
    await act(async () => {
      tabB.click();
    });
    expect(selectedTabId()).toBe(SPACE_B);

    await landOrder([SPACE_B, SPACE_A]);

    expect(selectedTabId()).toBe(SPACE_B);
  });

  it('keeps the shown Space after the tab the user picked was closed', async () => {
    // Closing a tab leaves the Space alive, so `activeSpaceId` goes on naming
    // it and resolving falls back to position — which a reorder then moves.
    meta.spaces = [
      { id: SPACE_A, name: 'Space A', type: 'document' },
      { id: SPACE_B, name: 'Space B', type: 'document' },
      { id: SPACE_C, name: 'Space C', type: 'document' },
    ];
    meta.openTabIds = [SPACE_A, SPACE_B, SPACE_C];
    setup();

    const tabC = await screen.findByTestId(`space-tab-${SPACE_C}`);
    await act(async () => {
      tabC.click();
    });
    expect(selectedTabId()).toBe(SPACE_C);

    // The user closes that tab. C is still a Space; only its tab is gone.
    await landOrder([SPACE_A, SPACE_B]);
    expect(selectedTabId()).toBe(SPACE_A);
    const mountsBefore = [...outletMounts];

    await landOrder([SPACE_B, SPACE_A]);

    expect(selectedTabId()).toBe(SPACE_A);
    expect(outletMounts).toEqual(mountsBefore);
  });

  it('shows the first tab once tabs arrive, having had none to show', async () => {
    // A project whose meta doc has not synced yet renders no tabs at all.
    // Pinning must wait for the list rather than settle on nothing.
    meta.spaces = [];
    meta.openTabIds = [];
    setup();
    expect(selectedTabId()).toBeNull();

    meta.spaces = [{ id: SPACE_A, name: 'Space A', type: 'document' }];
    await landOrder([SPACE_A]);

    expect(selectedTabId()).toBe(SPACE_A);
  });
});
