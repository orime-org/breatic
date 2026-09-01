// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the page does with a tab the user dropped somewhere new.
 *
 * The drag itself belongs to dnd-kit and is exercised in a real browser; what
 * is checked here is the page's half — the move goes out as a `tab:reorder`
 * over the live meta connection, the strip shows it at once, a refusal puts
 * the tab back, and a request that drew no answer leaves it where the user
 * dropped it because the server may have taken it. The
 * tab bar therefore stands in for itself, handing back the order it was given
 * and the callback a landed drag calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  act,
  waitFor,
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
    { id: SPACE_C, name: 'Space C', type: 'document' },
  ],
  openTabIds: [SPACE_A, SPACE_B, SPACE_C],
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

vi.mock('@web/pages/project/SpaceOutlet', () => ({
  SpaceOutlet: (): null => null,
}));

/** The last props the tab bar was rendered with. */
const barProps = vi.hoisted(
  () =>
    ({ current: null }) as {
      current: {
        spaces: ReadonlyArray<{ id: string }>;
        activeSpaceId: string;
        onActivate: (id: string) => void;
        onReorder?: (spaceId: string, beforeSpaceId: string | null) => void;
      } | null;
    },
);
vi.mock('@web/pages/project/chrome/tab-bar/SpaceTabBar', () => ({
  SpaceTabBar: (props: {
    spaces: ReadonlyArray<{ id: string }>;
    activeSpaceId: string;
    onActivate: (id: string) => void;
    onReorder?: (spaceId: string, beforeSpaceId: string | null) => void;
  }): null => {
    barProps.current = props;
    return null;
  },
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
import { SpaceRpcUnanswered } from '@web/data/yjs/space-rpc-client';
import { toast } from '@web/lib/toast';

const toastErrorMock = vi.mocked(toast.error);

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
 * The order the tab bar was last told to render.
 * @returns Those Space ids in order.
 */
function shownOrder(): string[] {
  return (barProps.current?.spaces ?? []).map((s) => s.id);
}

/**
 * Land a drag the way the tab bar does when the pointer is released.
 * @param spaceId - The tab that moved.
 * @param beforeSpaceId - The tab it landed in front of, null for the end.
 * @returns Resolves once the page has re-rendered.
 */
async function drop(
  spaceId: string,
  beforeSpaceId: string | null,
): Promise<void> {
  await act(async () => {
    barProps.current?.onReorder?.(spaceId, beforeSpaceId);
  });
}

describe('ProjectPage — a tab dropped somewhere new', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    barProps.current = null;
    meta.spaces = [
      { id: SPACE_A, name: 'Space A', type: 'document' },
      { id: SPACE_B, name: 'Space B', type: 'document' },
      { id: SPACE_C, name: 'Space C', type: 'document' },
    ];
    meta.openTabIds = [SPACE_A, SPACE_B, SPACE_C];
    sendSpaceRpcMock.mockResolvedValue({
      id: 'r1',
      ok: true,
      result: { wrote: true },
    });
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

  it('sends the move over the live meta connection', async () => {
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B, SPACE_C]));

    await drop(SPACE_C, SPACE_A);

    expect(sendSpaceRpcMock).toHaveBeenCalledWith(fakeProvider, {
      type: 'tab:reorder',
      payload: { spaceId: SPACE_C, beforeSpaceId: SPACE_A },
    });
  });

  it('shows the move before the document has heard about it', async () => {
    // The strip is what the user let go of; waiting for the round trip would
    // snap the tab back under the pointer and forward again.
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B, SPACE_C]));

    await drop(SPACE_C, SPACE_A);

    expect(meta.openTabIds).toEqual([SPACE_A, SPACE_B, SPACE_C]);
    expect(shownOrder()).toEqual([SPACE_C, SPACE_A, SPACE_B]);
  });

  it('puts the tab back when the server refuses the move', async () => {
    sendSpaceRpcMock.mockResolvedValue({
      id: 'r1',
      ok: false,
      error: { code: 'FORBIDDEN', message: 'forbidden' },
    });
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B, SPACE_C]));

    await drop(SPACE_C, SPACE_A);

    await waitFor(() =>
      expect(shownOrder()).toEqual([SPACE_A, SPACE_B, SPACE_C]),
    );
    // A refusal is what "that failed" is for. The line reserved for a missing
    // answer belongs to the case where the tab stays put.
    expect(toastErrorMock).toHaveBeenLastCalledWith('Failed to move the tab', {
      description: 'forbidden',
    });
  });

  it('leaves the tab where the user dropped it when no answer came back', async () => {
    // Nothing recalls a request that timed out, so the server may have taken
    // it. The strip keeps the move and says the server did not answer.
    sendSpaceRpcMock.mockRejectedValue(new SpaceRpcUnanswered('timeout'));
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B, SPACE_C]));

    await drop(SPACE_C, SPACE_A);

    await waitFor(() =>
      expect(shownOrder()).toEqual([SPACE_C, SPACE_A, SPACE_B]),
    );
    // One argument, and it neither claims the move failed nor asks the user
    // to try again — the reorder path passes its own line for this case.
    expect(toastErrorMock).toHaveBeenLastCalledWith(
      'The server did not answer. Reload to see the current tab order.',
    );
  });

  it('lands on the first tab the user can see when the shown Space is deleted', async () => {
    // The strip is showing a drag that the document has not caught up with,
    // so the stored order and the order on screen disagree about which tab is
    // first. What the user is looking at is the one to land on.
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B, SPACE_C]));
    expect(barProps.current?.activeSpaceId).toBe(SPACE_A);

    await drop(SPACE_C, SPACE_A);
    expect(shownOrder()).toEqual([SPACE_C, SPACE_A, SPACE_B]);

    // A collaborator deletes Space A — the one being shown.
    meta.spaces = meta.spaces.filter((s) => s.id !== SPACE_A);
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });
    expect(barProps.current?.activeSpaceId).toBe(SPACE_C);

    // Another drag is what tells the two apart: falling back by position lands
    // on C above too, and only a choice by id survives the order moving under
    // it.
    await drop(SPACE_B, SPACE_C);
    expect(shownOrder()).toEqual([SPACE_B, SPACE_C]);

    expect(barProps.current?.activeSpaceId).toBe(SPACE_C);
  });

  it('lets go of the shown order once the broadcast lands', async () => {
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B, SPACE_C]));
    await drop(SPACE_C, SPACE_A);

    meta.openTabIds = [SPACE_C, SPACE_A, SPACE_B];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });

    expect(shownOrder()).toEqual([SPACE_C, SPACE_A, SPACE_B]);
  });
});

describe('ProjectPage — opening a Space that has no tab yet', () => {
  // The pinning effect exists so a reorder cannot move which Space is shown.
  // Picking a Space from the drawer reaches the same shape from the other
  // direction: the choice names a Space the tab list does not hold YET,
  // because tab:open is still travelling.
  beforeEach(() => {
    vi.clearAllMocks();
    barProps.current = null;
    meta.spaces = [
      { id: SPACE_A, name: 'Space A', type: 'document' },
      { id: SPACE_B, name: 'Space B', type: 'document' },
      { id: SPACE_C, name: 'Space C', type: 'document' },
    ];
    // C exists in the project but is not on this user's strip.
    meta.openTabIds = [SPACE_A, SPACE_B];
    sendSpaceRpcMock.mockResolvedValue({ id: 'r1', ok: true });
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

  it('keeps the choice while its tab is still on the way', async () => {
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B]));

    await act(async () => {
      barProps.current?.onActivate(SPACE_C);
    });

    // tab:open is out. Until it lands there is no tab for C and the page
    // shows what it showed before.
    expect(sendSpaceRpcMock).toHaveBeenCalledWith(fakeProvider, {
      type: 'tab:open',
      payload: { spaceId: SPACE_C },
    });

    // The broadcast lands and the tab appears — on the Space that was picked.
    meta.openTabIds = [SPACE_A, SPACE_B, SPACE_C];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });

    expect(barProps.current?.activeSpaceId).toBe(SPACE_C);
  });

  it('settles on what is shown when that tab never arrives', async () => {
    // The open failed, so C has no tab and never will. Falling back by
    // position is what the page shows meanwhile — and leaving the choice
    // pointing at C leaves that fallback standing, which is exactly what a
    // reorder then moves.
    sendSpaceRpcMock.mockRejectedValue(new Error('unreachable'));
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B]));

    await act(async () => {
      barProps.current?.onActivate(SPACE_C);
    });

    meta.openTabIds = [SPACE_B, SPACE_A];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });

    expect(barProps.current?.activeSpaceId).toBe(SPACE_A);
  });

  it('goes back to waiting for a tab the user returns to', async () => {
    // Picked C from the drawer, switched back to A before C's tab landed,
    // then returned to C. What ends the wait is the choice naming C again
    // with C's tab on the strip; while the choice sat on A the pending open
    // held nothing back, because the guard compares it against the choice.
    // Closing C's tab after that is the ordinary case, and the page settles
    // on what it shows rather than falling back by position.
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B]));

    await act(async () => {
      barProps.current?.onActivate(SPACE_C);
    });
    await act(async () => {
      barProps.current?.onActivate(SPACE_A);
    });
    meta.openTabIds = [SPACE_A, SPACE_B, SPACE_C];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });

    // Back to C, then close its tab.
    await act(async () => {
      barProps.current?.onActivate(SPACE_C);
    });
    meta.openTabIds = [SPACE_A, SPACE_B];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: true });
    });
    expect(barProps.current?.activeSpaceId).toBe(SPACE_A);

    meta.openTabIds = [SPACE_B, SPACE_A];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });

    expect(barProps.current?.activeSpaceId).toBe(SPACE_A);
  });

  it('settles on what is shown when that tab is later closed', async () => {
    // The open landed, so waiting for it is over. Closing the tab afterwards
    // is the ordinary case again — the choice names a Space with no tab, and
    // it has to become the one on screen or a reorder will move the body.
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_A, SPACE_B]));

    await act(async () => {
      barProps.current?.onActivate(SPACE_C);
    });
    meta.openTabIds = [SPACE_A, SPACE_B, SPACE_C];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });
    expect(barProps.current?.activeSpaceId).toBe(SPACE_C);

    // The user closes it. C is still a Space; only its tab is gone.
    meta.openTabIds = [SPACE_A, SPACE_B];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: true });
    });
    expect(barProps.current?.activeSpaceId).toBe(SPACE_A);

    meta.openTabIds = [SPACE_B, SPACE_A];
    await act(async () => {
      useUIStore.setState({ chatPanelCollapsed: false });
    });

    expect(barProps.current?.activeSpaceId).toBe(SPACE_A);
  });
});
