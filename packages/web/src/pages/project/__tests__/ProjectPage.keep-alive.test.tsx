// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Switching Space tabs hides the Space it leaves and keeps it mounted; only
 * closing the tab unmounts it (inner#1235 A1, A8, A9). The body is a probe
 * that holds a click count in its own state, so "the same mount" is something
 * a test can read rather than infer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  waitFor,
  act,
  cleanup as cleanupPage,
  type RenderOptions,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';

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

/** The live Space list. Replaced, never mutated, so a change re-renders. */
const meta: {
  spaces: Array<{
    id: string;
    name: string;
    type: 'document';
    createdAt: number;
  }>;
} = {
  spaces: [
    { id: SPACE_A, name: 'Space A', type: 'document', createdAt: 1 },
    { id: SPACE_B, name: 'Space B', type: 'document', createdAt: 2 },
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

const evictCanvasUndoManagerMock = vi.fn();
vi.mock('@web/data/yjs/canvas-space', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/canvas-space')
      >('@web/data/yjs/canvas-space');
  return {
    ...actual,
    evictCanvasUndoManager: (name: string) =>
      evictCanvasUndoManagerMock(name),
  };
});

const evictDocumentEditorMock = vi.fn();
vi.mock('@web/spaces/document/document-editor-cache', async () => {
  const actual = await vi.importActual<
    typeof import('@web/spaces/document/document-editor-cache')
      >('@web/spaces/document/document-editor-cache');
  return {
    ...actual,
    evictDocumentEditor: (name: string) => evictDocumentEditorMock(name),
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

const bodyMounts: Record<string, number> = {};
vi.mock('@web/pages/project/SpaceOutlet', () => ({
  /**
   * Counts real mounts in a state initializer, which an Activity hide and
   * show does not re-run, and keeps a click count of its own.
   * @param root0 - Component props.
   * @param root0.spaceId - The Space this body belongs to.
   * @returns The probe.
   */
  SpaceOutlet: ({ spaceId }: { spaceId: string }): React.JSX.Element => {
    React.useState(() => {
      bodyMounts[spaceId] = (bodyMounts[spaceId] ?? 0) + 1;
      return null;
    });
    const [clicks, setClicks] = React.useState(0);
    return (
      <button
        type='button'
        data-testid={`probe-${spaceId}`}
        onClick={() => setClicks((n) => n + 1)}
      >
        {clicks}
      </button>
    );
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

describe('ProjectPage — switching a tab hides its Space, closing it unmounts it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(bodyMounts)) delete bodyMounts[key];
    window.localStorage.clear();
    meta.spaces = [
      { id: SPACE_A, name: 'Space A', type: 'document', createdAt: 1 },
      { id: SPACE_B, name: 'Space B', type: 'document', createdAt: 2 },
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
   * Open Space A from the drawer next to Space B, which opened by itself.
   * @returns once Space A is the active tab.
   */
  async function openBoth(): Promise<void> {
    setup();
    await screen.findByTestId(`probe-${SPACE_B}`);
    (await screen.findByTestId('space-drawer-trigger')).click();
    const row = await screen.findByTestId(`space-drawer-row-${SPACE_A}`);
    (row.querySelector('button') as HTMLButtonElement).click();
    await screen.findByTestId(`probe-${SPACE_A}`);
  }

  it('keeps the Space it leaves mounted and hidden', async () => {
    await openBoth();

    expect(screen.getByTestId(`probe-${SPACE_B}`)).not.toBeVisible();
    expect(screen.getByTestId(`probe-${SPACE_A}`)).toBeVisible();
    expect(bodyMounts[SPACE_B]).toBe(1);
  });

  it('comes back to the same mount, with its own state, when switched back', async () => {
    await openBoth();
    await act(async () => {
      screen.getByTestId(`probe-${SPACE_A}`).click();
    });
    expect(screen.getByTestId(`probe-${SPACE_A}`).textContent).toBe('1');

    await act(async () => {
      screen.getByTestId(`space-tab-${SPACE_B}`).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId(`probe-${SPACE_B}`)).toBeVisible();
    });
    await act(async () => {
      screen.getByTestId(`space-tab-${SPACE_A}`).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId(`probe-${SPACE_A}`)).toBeVisible();
    });
    expect(screen.getByTestId(`probe-${SPACE_A}`).textContent).toBe('1');
    expect(bodyMounts[SPACE_A]).toBe(1);
    expect(bodyMounts[SPACE_B]).toBe(1);
  });

  it('unmounts the Space when its tab is closed, and mounts it fresh when reopened', async () => {
    await openBoth();

    (await screen.findByTestId(`space-tab-close-${SPACE_B}`)).click();
    await waitFor(() => {
      expect(screen.queryByTestId(`probe-${SPACE_B}`)).toBeNull();
    });

    (await screen.findByTestId('space-drawer-trigger')).click();
    const row = await screen.findByTestId(`space-drawer-row-${SPACE_B}`);
    (row.querySelector('button') as HTMLButtonElement).click();
    await screen.findByTestId(`probe-${SPACE_B}`);
    expect(bodyMounts[SPACE_B]).toBe(2);
  });

  it('mounts a restored tab only when it is first switched to', async () => {
    await openBoth();
    cleanupPage();
    for (const key of Object.keys(bodyMounts)) delete bodyMounts[key];

    setup();
    await screen.findByTestId(`probe-${SPACE_A}`);
    await screen.findByTestId(`space-tab-${SPACE_B}`);
    expect(screen.queryByTestId(`probe-${SPACE_B}`)).toBeNull();

    await act(async () => {
      screen.getByTestId(`space-tab-${SPACE_B}`).click();
    });
    await screen.findByTestId(`probe-${SPACE_B}`);
    expect(bodyMounts[SPACE_B]).toBe(1);
  });
});
