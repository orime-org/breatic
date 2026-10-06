// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the project page restores from this account's stored preferences
 * before its first frame: whether the Agent panel is open (per account and
 * project) and the canvas minimap and snap toggles (per account).
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
import { writeAgentPanelOpen } from '@web/lib/project-tabs-storage';
import { writeUserPreference } from '@web/lib/user-preferences-storage';
import { useCanvasStore, useCurrentUserStore, useUIStore } from '@web/stores';

const PID = '11111111-1111-4111-8111-111111111111';
const SPACE_A = '22222222-2222-4222-8222-222222222222';
const SPACE_B = '33333333-3333-4333-8333-333333333333';
const SPACE_C = '44444444-4444-4444-8444-444444444444';
const OTHER_PID = '66666666-6666-4666-8666-666666666666';

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

/** How many times the Agent column was mounted. */
const agentMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@web/pages/project/chrome/AgentColumn', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    AgentColumn: (): null => {
      react.useEffect(() => {
        agentMounts.count += 1;
      }, []);
      return null;
    },
  };
});

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
        onClose?: (id: string) => void;
        onReorder?: (spaceId: string, beforeSpaceId: string | null) => void;
      } | null;
    },
);
vi.mock('@web/pages/project/chrome/tab-bar/SpaceTabBar', () => ({
  SpaceTabBar: (props: {
    spaces: ReadonlyArray<{ id: string }>;
    activeSpaceId: string;
    onActivate: (id: string) => void;
    onClose?: (id: string) => void;
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
const PROJECT = {
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
  archivedAt: null,
  canRestore: false,
};

/**
 * Render the project page with the project already in the query cache, the
 * way it is when the reader comes back to a project opened earlier in the
 * session: the page has the data on its very first render.
 */
function setupCached(): void {
  getMock.mockResolvedValue(PROJECT);
  membersListMock.mockResolvedValue({ members: [] });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  qc.setQueryData(['project', PID], PROJECT);
  rtlRender(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/project/demo-${PID}`]}>
          <Routes>
            <Route path='/project/:projectId' element={<ProjectPage />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function setup(): void {
  getMock.mockResolvedValue(PROJECT);
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
 * Sign an account in.
 * @param id - The account id.
 */
function signIn(id: string): void {
  useCurrentUserStore.setState({
    user: {
      id,
      name: id,
      email: `${id}@e.com`,
      personalStudio: { name: id, slug: id, avatarUrl: null },
      membershipTier: 'base',
    },
  });
}

describe('ProjectPage — preferences restored before the first frame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentMounts.count = 0;
    barProps.current = null;
    sendSpaceRpcMock.mockResolvedValue({ id: 'r1', ok: true });
    useUIStore.setState({ chatPanelCollapsed: false, spaceOpInProgress: null });
    useCanvasStore.setState({ minimapVisible: true, snapToGrid: false });
    signIn('u-me');
  });

  it('never mounts the Agent column when this account hid it in this project', async () => {
    writeAgentPanelOpen('u-me', PID, false);
    setup();
    await waitFor(() => expect(barProps.current).not.toBeNull());

    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
    expect(agentMounts.count).toBe(0);
  });

  it('never mounts the Agent column it hid when the project data is already cached', async () => {
    writeAgentPanelOpen('u-me', PID, false);
    setupCached();
    await waitFor(() => expect(barProps.current).not.toBeNull());

    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
    expect(agentMounts.count).toBe(0);
  });

  it('opens the Agent column where nothing is stored, whatever the last project left', async () => {
    useUIStore.setState({ chatPanelCollapsed: true });
    writeAgentPanelOpen('u-me', OTHER_PID, false);
    setup();
    await waitFor(() => expect(agentMounts.count).toBe(1));

    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
  });

  it('ignores what another account stored for this project', async () => {
    writeAgentPanelOpen('u-other', PID, false);
    setup();
    await waitFor(() => expect(agentMounts.count).toBe(1));
  });

  it('writes the panel toggle to this account and project', async () => {
    setup();
    await waitFor(() => expect(barProps.current).not.toBeNull());

    act(() => useUIStore.getState().toggleChatPanel());

    const stored = JSON.parse(window.localStorage.getItem('breatic.projectTabs') ?? '{}') as Record<
      string,
      Record<string, { agentPanelOpen?: boolean }>
    >;
    expect(stored['u-me']?.[PID]?.agentPanelOpen).toBe(false);
  });

  it('restores the minimap and snap this account stored', async () => {
    writeUserPreference('u-me', { minimapVisible: false, snapToGrid: true });
    setup();
    await waitFor(() => expect(barProps.current).not.toBeNull());

    expect(useCanvasStore.getState().minimapVisible).toBe(false);
    expect(useCanvasStore.getState().snapToGrid).toBe(true);
  });

  it('puts back the defaults for an account that stored nothing', async () => {
    useCanvasStore.setState({ minimapVisible: false, snapToGrid: true });
    writeUserPreference('u-other', { minimapVisible: false, snapToGrid: true });
    setup();
    await waitFor(() => expect(barProps.current).not.toBeNull());

    expect(useCanvasStore.getState().minimapVisible).toBe(true);
    expect(useCanvasStore.getState().snapToGrid).toBe(false);
  });
});
