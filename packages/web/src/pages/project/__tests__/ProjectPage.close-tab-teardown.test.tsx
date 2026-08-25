// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Closing a tab destroys two things — the Space's canvas undo manager and its
 * document editor (which owns its own undo stack and selection) — and design
 * §6.6.2 fixes WHEN that is allowed to happen: only once the id has actually
 * left this user's `openTabIds`, i.e. once the broadcast has landed.
 *
 * Before the RPC existed, closing a tab was a synchronous local write that
 * could not fail, so `onCloseTab` destroyed both caches on the spot. Now the
 * close is a round trip and it CAN fail. Destroying at request time would
 * leave a failed close showing a tab on screen whose undo history is already
 * gone — the user's typing with nowhere to go back to.
 *
 * So the promise is: the request moves nothing, and the list moves everything.
 * These three cases are the whole promise — a failed close, an accepted close
 * whose broadcast has not arrived yet, and the broadcast landing.
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
import { toast } from '@web/lib/toast';

const PID = '11111111-1111-4111-8111-111111111111';
const SPACE_A = '22222222-2222-4222-8222-222222222222';
const SPACE_B = '33333333-3333-4333-8333-333333333333';

/** Doc names the two caches are keyed by — asserted, not reconstructed. */
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

/**
 * The live meta state. Both fields are replaced (never mutated in place) so a
 * case can land a broadcast: the effect that discards a departed tab's caches
 * is keyed on the `openTabIds` IDENTITY, so handing back a fresh array is what
 * a broadcast looks like from the page's side — and handing back the same one
 * is what "no broadcast yet" looks like.
 */
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

/**
 * Re-render the page without changing the meta state, and flush anything the
 * RPC promise queued behind it. The page subscribes to `chatPanelCollapsed`,
 * so flipping it forces the effects to re-evaluate against whatever `meta`
 * currently holds — which is how a case proves an eviction did NOT happen for
 * want of a broadcast rather than for want of a render. The async `act` also
 * drains the microtask queue, so a teardown hung off the request's own
 * resolution would have run by the time the assertions read the spies.
 * @returns Resolves once React has re-rendered and settled.
 */
async function rerenderPage(): Promise<void> {
  await act(async () => {
    useUIStore.setState({
      chatPanelCollapsed: !useUIStore.getState().chatPanelCollapsed,
    });
  });
}

/**
 * Land the `tab:close` broadcast: the id really leaves this user's list.
 * @param remaining - The open-tab ids the server now says this user has.
 * @returns Resolves once the page has re-rendered against the new list.
 */
async function landBroadcast(remaining: readonly string[]): Promise<void> {
  meta.openTabIds = remaining;
  await rerenderPage();
}

describe('ProjectPage — a close tears down only once the tab has left the list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('a failed tab:close destroys neither cache and leaves the tab in place', async () => {
    sendSpaceRpcMock.mockRejectedValue(
      new Error('Space RPC timeout for type=tab:close (id=x, 10000ms)'),
    );
    setup();

    const closeB = await screen.findByTestId(`space-tab-close-${SPACE_B}`);
    closeB.click();

    // The request really went out and really came back a failure — without
    // this the two zero-call assertions below would also pass on a page that
    // never wired the close button up at all.
    await waitFor(() => {
      expect(sendSpaceRpcMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSpaceRpcMock.mock.calls[0]?.[1]).toEqual({
      type: 'tab:close',
      payload: { spaceId: SPACE_B },
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    await rerenderPage();

    expect(evictCanvasUndoManagerMock).not.toHaveBeenCalled();
    expect(evictDocumentEditorMock).not.toHaveBeenCalled();
    // Still on screen, and still this user's tab: a failed close is a close
    // that never happened.
    expect(screen.getByTestId(`space-tab-${SPACE_B}`)).toBeInTheDocument();
    expect(meta.openTabIds).toEqual([SPACE_A, SPACE_B]);
  });

  it('an accepted tab:close destroys neither cache while the broadcast is still in flight', async () => {
    sendSpaceRpcMock.mockResolvedValue({ id: 'r1', ok: true, data: {} });
    setup();

    const closeB = await screen.findByTestId(`space-tab-close-${SPACE_B}`);
    closeB.click();

    await waitFor(() => {
      expect(sendSpaceRpcMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSpaceRpcMock.mock.calls[0]?.[1]).toEqual({
      type: 'tab:close',
      payload: { spaceId: SPACE_B },
    });
    // The server said yes. The list has not moved yet, and the list is what
    // teardown follows — so a render in this window must still change nothing.
    expect(toast.error).not.toHaveBeenCalled();
    await rerenderPage();

    expect(evictCanvasUndoManagerMock).not.toHaveBeenCalled();
    expect(evictDocumentEditorMock).not.toHaveBeenCalled();
    expect(screen.getByTestId(`space-tab-${SPACE_B}`)).toBeInTheDocument();
  });

  it('the broadcast landing destroys each cache exactly once, for that tab only', async () => {
    sendSpaceRpcMock.mockResolvedValue({ id: 'r1', ok: true, data: {} });
    setup();

    const closeB = await screen.findByTestId(`space-tab-close-${SPACE_B}`);
    closeB.click();

    await waitFor(() => {
      expect(sendSpaceRpcMock).toHaveBeenCalledTimes(1);
    });
    // Precondition, and the reason "exactly once" below means what it says:
    // nothing had been destroyed up to this point.
    expect(evictCanvasUndoManagerMock).not.toHaveBeenCalled();
    expect(evictDocumentEditorMock).not.toHaveBeenCalled();

    await landBroadcast([SPACE_A]);

    expect(evictCanvasUndoManagerMock).toHaveBeenCalledTimes(1);
    expect(evictCanvasUndoManagerMock).toHaveBeenCalledWith(CANVAS_DOC_B);
    expect(evictDocumentEditorMock).toHaveBeenCalledTimes(1);
    expect(evictDocumentEditorMock).toHaveBeenCalledWith(DOCUMENT_DOC_B);
    // The tab that stayed keeps everything it had.
    expect(evictCanvasUndoManagerMock).not.toHaveBeenCalledWith(
      `project-${PID}/canvas-${SPACE_A}`,
    );
    expect(evictDocumentEditorMock).not.toHaveBeenCalledWith(
      `project-${PID}/document-${SPACE_A}`,
    );
    expect(screen.queryByTestId(`space-tab-${SPACE_B}`)).toBeNull();
    expect(screen.getByTestId(`space-tab-${SPACE_A}`)).toBeInTheDocument();

    // A further render with the list unchanged must not destroy anything a
    // second time — the teardown follows the tab LEAVING, not the tab being
    // absent.
    await rerenderPage();
    expect(evictCanvasUndoManagerMock).toHaveBeenCalledTimes(1);
    expect(evictDocumentEditorMock).toHaveBeenCalledTimes(1);
  });
});
