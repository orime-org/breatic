// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Closing a tab destroys two things — the Space's canvas undo manager and its
 * document editor (which owns its own undo stack and selection) — and the page
 * fixes WHEN: once the id has left the strip, whoever took it off.
 *
 * Driven by the strip rather than by the close handler, so a Space somebody
 * deleted reaches the same teardown as a tab the user closed. Both caches are
 * keyed by doc name and evicting an unknown name is a no-op, so the page calls
 * both without checking the Space type; naming the doc rather than counting
 * calls is what makes "for that tab only" an assertion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  waitFor,
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

/** Doc names the two caches are keyed by — asserted, not reconstructed. */
const CANVAS_DOC_A = `project-${PID}/canvas-${SPACE_A}`;
const DOCUMENT_DOC_A = `project-${PID}/document-${SPACE_A}`;
const CANVAS_DOC_B = `project-${PID}/canvas-${SPACE_B}`;
const DOCUMENT_DOC_B = `project-${PID}/document-${SPACE_B}`;

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


describe('ProjectPage — closing a tab discards what that tab was holding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
   * Put Space A on the strip alongside the one that opened by itself.
   * @returns once both tabs are painted.
   */
  async function openBoth(): Promise<void> {
    setup();
    (await screen.findByTestId('space-drawer-trigger')).click();
    const row = await screen.findByTestId(`space-drawer-row-${SPACE_A}`);
    (row.querySelector('button') as HTMLButtonElement).click();
    await screen.findByTestId(`space-tab-${SPACE_A}`);
  }

  it('discards each cache exactly once, for that tab only', async () => {
    // Both caches are keyed by doc name and evicting an unknown name is a
    // no-op, so the page calls both without checking the Space type. Naming
    // the doc rather than counting calls is what makes "for that tab only"
    // an assertion rather than an accident of how many tabs were open.
    await openBoth();

    (await screen.findByTestId(`space-tab-close-${SPACE_A}`)).click();

    await waitFor(() => {
      expect(screen.queryByTestId(`space-tab-${SPACE_A}`)).toBeNull();
    });
    expect(evictCanvasUndoManagerMock).toHaveBeenCalledTimes(1);
    expect(evictCanvasUndoManagerMock).toHaveBeenCalledWith(
      CANVAS_DOC_A,
    );
    expect(evictDocumentEditorMock).toHaveBeenCalledTimes(1);
    expect(evictDocumentEditorMock).toHaveBeenCalledWith(
      DOCUMENT_DOC_A,
    );
  });

  it('discards what a Space somebody else deleted was holding', async () => {
    // The deletion path reaches the same teardown: the tab leaves the strip
    // without anybody clicking its close button.
    await openBoth();

    await act(async () => {
      meta.spaces = meta.spaces.filter((sp) => sp.id !== SPACE_A);
      useUIStore.setState((st) => ({
        chatPanelCollapsed: !st.chatPanelCollapsed,
      }));
    });

    await waitFor(() => {
      expect(evictCanvasUndoManagerMock).toHaveBeenCalledWith(
        CANVAS_DOC_A,
      );
    });
    expect(evictDocumentEditorMock).toHaveBeenCalledWith(
      DOCUMENT_DOC_A,
    );
  });

  it('keeps a tab that is still open untouched', async () => {
    await openBoth();

    (await screen.findByTestId(`space-tab-close-${SPACE_A}`)).click();

    await waitFor(() => {
      expect(screen.queryByTestId(`space-tab-${SPACE_A}`)).toBeNull();
    });
    expect(evictCanvasUndoManagerMock).not.toHaveBeenCalledWith(
      CANVAS_DOC_B,
    );
    expect(evictDocumentEditorMock).not.toHaveBeenCalledWith(
      DOCUMENT_DOC_B,
    );
  });
});
