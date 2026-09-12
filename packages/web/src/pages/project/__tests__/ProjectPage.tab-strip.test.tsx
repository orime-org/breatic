// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Space tab strip, which is runtime state of this one browser tab.
 *
 * The drag itself belongs to dnd-kit and is exercised in a real browser; what
 * is checked here is the page's half — that a released drag lands at once and
 * sends nothing, that the live Space list drops tabs whose Space is gone and
 * opens nothing somebody else created, that an unsynced document seeds nothing,
 * and that a project switch starts again from the next project's newest Space.
 * The tab bar therefore stands in for itself, handing back the order it was
 * given so a case can read what the page decided.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  act,
  waitFor,
  type RenderOptions,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';

const PID = '11111111-1111-4111-8111-111111111111';
const SPACE_A = '22222222-2222-4222-8222-222222222222';
const SPACE_B = '33333333-3333-4333-8333-333333333333';
const SPACE_C = '44444444-4444-4444-8444-444444444444';
const SPACE_D = '55555555-5555-4555-8555-555555555555';
const SPACE_E = '66666666-6666-4666-8666-666666666666';
const OTHER_PID = '77777777-7777-4777-8777-777777777777';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

/** Stands in for a mounted provider; the activity panel subscribes to it. */
const fakeProvider = { on: (): void => {}, off: (): void => {} } as never;

const meta: {
  spaces: Array<{
    id: string;
    name: string;
    type: 'document';
    createdAt: number;
  }>;
  /** What `useProjectMeta` answers for "this projection is the one you asked for". */
  synced: boolean;
} = {
  synced: true,
  spaces: [
    { id: SPACE_A, name: 'Space A', type: 'document', createdAt: 1 },
    { id: SPACE_B, name: 'Space B', type: 'document', createdAt: 2 },
    { id: SPACE_C, name: 'Space C', type: 'document', createdAt: 3 },
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
      synced: meta.synced,
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

/** Holds the router's `navigate` so a case can change the address. */
const navigate: { current: ((to: string) => void) | null } = { current: null };

/**
 * Renders nothing; its only job is to hand `navigate` out of the router.
 * @returns Nothing rendered.
 */
function Navigator(): null {
  navigate.current = useNavigate();
  return null;
}

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
      <Navigator />
      <Routes>
        <Route path='/project/:projectId' element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Go to another project without remounting the page: the route pattern is
 * unchanged, which is exactly the shape the reset action exists for.
 * @param projectId - The project to go to.
 * @returns Nothing.
 */
function rerenderAt(projectId: string): void {
  navigate.current?.(`/project/demo-${projectId}`);
}

/**
 * The order the tab bar was last told to render.
 * @returns Those Space ids in order.
 */
function shownOrder(): string[] {
  return (barProps.current?.spaces ?? []).map((s) => s.id);
}

/**
 * Apply a change somebody else made to the Space list and make the page read
 * it again. The mocked `useProjectMeta` has no subscription of its own, so the
 * re-render is driven through a UI-store field the page already watches.
 * @param mutate - Mutation to apply to `meta` before the re-render.
 * @returns Nothing.
 */
function landBroadcast(mutate: () => void): void {
  act(() => {
    mutate();
    useUIStore.setState((s) => ({ chatPanelCollapsed: !s.chatPanelCollapsed }));
  });
}

describe('ProjectPage — the strip is this browser tab\'s own', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    barProps.current = null;
    meta.synced = true;
    meta.spaces = [
      { id: SPACE_A, name: 'Space A', type: 'document', createdAt: 1 },
      { id: SPACE_B, name: 'Space B', type: 'document', createdAt: 2 },
      { id: SPACE_C, name: 'Space C', type: 'document', createdAt: 3 },
    ];
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

  /**
   * Put all three Spaces on the strip, in order.
   * @returns once the strip shows A, B, C.
   */
  async function openAllThree(): Promise<void> {
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_C]));
    await act(async () => {
      barProps.current?.onActivate?.(SPACE_A);
    });
    await act(async () => {
      barProps.current?.onActivate?.(SPACE_B);
    });
    await waitFor(() =>
      expect(shownOrder()).toEqual([SPACE_C, SPACE_A, SPACE_B]),
    );
  }

  it('opens the newest Space alone, and nothing else', async () => {
    setup();
    await waitFor(() => expect(shownOrder()).toEqual([SPACE_C]));
    expect(sendSpaceRpcMock).not.toHaveBeenCalled();
  });

  it('shows a released drag at once and sends nothing', async () => {
    // The strip is what the user let go of. It used to be a round trip, and
    // waiting for one snapped the tab back under the pointer and forward
    // again.
    await openAllThree();

    await act(async () => {
      barProps.current?.onReorder?.(SPACE_B, SPACE_C);
    });

    expect(shownOrder()).toEqual([SPACE_B, SPACE_C, SPACE_A]);
    expect(sendSpaceRpcMock).not.toHaveBeenCalled();
  });

  it('drops a tab whose Space somebody deleted', async () => {
    await openAllThree();

    landBroadcast(() => {
      meta.spaces = meta.spaces.filter((s) => s.id !== SPACE_A);
    });

    await waitFor(() => expect(shownOrder()).toEqual([SPACE_C, SPACE_B]));
  });

  it('lands on the leftmost survivor when the shown Space is deleted', async () => {
    await openAllThree();
    await waitFor(() => expect(barProps.current?.activeSpaceId).toBe(SPACE_B));

    landBroadcast(() => {
      meta.spaces = meta.spaces.filter((s) => s.id !== SPACE_B);
    });

    await waitFor(() => expect(barProps.current?.activeSpaceId).toBe(SPACE_C));
  });

  it('opens nothing until the document says it is the one asked for', async () => {
    // An unsynced document reads as a project with no Spaces. Seeding off that
    // would make every later arrival look like somebody else creating one, so
    // the strip would stay empty for good. `synced` is also false for the one
    // render after a project switch, when `spaces` still holds the previous
    // project's list.
    meta.synced = false;
    setup();
    await waitFor(() => expect(barProps.current).not.toBeNull());
    expect(shownOrder()).toEqual([]);

    landBroadcast(() => {
      meta.synced = true;
    });

    await waitFor(() => expect(shownOrder()).toEqual([SPACE_C]));
  });

  it('starts the next project from its own newest Space', async () => {
    // The route pattern is unchanged across an A→B switch so this component is
    // not remounted; without the reset it would carry A's strip into B.
    await openAllThree();

    await act(async () => {
      meta.synced = false;
      meta.spaces = [
        { id: SPACE_D, name: 'Space D', type: 'document', createdAt: 1 },
        { id: SPACE_E, name: 'Space E', type: 'document', createdAt: 2 },
      ];
      rerenderAt(OTHER_PID);
    });
    await act(async () => {
      meta.synced = true;
      rerenderAt(OTHER_PID);
    });

    await waitFor(() => expect(shownOrder()).toEqual([SPACE_E]));
    expect(barProps.current?.activeSpaceId).toBe(SPACE_E);
  });

  it('does not open a Space somebody else created', async () => {
    await openAllThree();

    landBroadcast(() => {
      meta.spaces = [
        ...meta.spaces,
        { id: SPACE_D, name: 'Space D', type: 'document', createdAt: 9 },
      ];
    });

    await waitFor(() =>
      expect(shownOrder()).toEqual([SPACE_C, SPACE_A, SPACE_B]),
    );
  });
});
