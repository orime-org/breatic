// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Handing a canvas note to an external agent (#1488 §11.7, §11.9): the button
 * on the note asks collab on the canvas's own connection, the label follows
 * the server's record, and the agent's reply carries its name.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ProjectRole } from '@breatic/shared';
import type { AnnotationNodeView } from '@breatic/shared/canvas-model';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { AnnotationSticky } from '@web/spaces/canvas/annotation/AnnotationSticky';
import { AnnotationNamesContext } from '@web/spaces/canvas/annotation/names';
import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { useCanvasStore } from '@web/stores/canvas';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCurrentUserStore } from '@web/stores/current-user';

const sendSpaceCommentRequest = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@web/data/yjs/comment-requests', async (real) => ({
  ...(await real<typeof import('@web/data/yjs/comment-requests')>()),
  sendSpaceCommentRequest,
}));

vi.mock('@web/lib/toast', async (real) => {
  const actual = await real<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

vi.mock('@web/data/yjs/canvas-space', () => ({
  addReply: () => true,
  editAnnotationBody: () => true,
  editReply: () => true,
  removeReply: () => undefined,
  runCanvasUndoBatch: (_p: string, _s: string, _o: unknown, write: () => void) => {
    write();
    return { ok: true };
  },
}));

vi.mock('@web/data/use-project-members', () => ({
  useProjectMembers: () => ({ members: [], isLoading: false, isError: false, retry: () => undefined }),
}));

const api = vi.hoisted(() => ({
  listConnections: vi.fn(),
  spaceAssignments: vi.fn(),
  connectionNames: vi.fn(),
}));

vi.mock('@web/data/api/agent-access', async (real) => ({
  ...(await real<typeof import('@web/data/api/agent-access')>()),
  agentAccessApi: api,
}));

const NAMES = new Map([['u-me', { id: 'u-me', name: 'Mika', email: '' }]]);

/**
 * A note on a canvas, as the viewer with this role sees it.
 * @param data - The note.
 * @param role - The viewer's role.
 */
function mount(data: AnnotationNodeView, role: ProjectRole = 'editor'): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <CanvasContext.Provider
          value={{ projectId: 'p1', spaceId: 's1', readOnly: role === 'viewer', myRole: role, caretProvider: null }}
        >
          <CanvasActionsContext.Provider
            value={{
              renameNode: () => undefined,
              deleteEdge: () => undefined,
              deleteNode: () => undefined,
              activateNodeUpload: () => undefined,
              commitGroupResize: () => undefined,
              reportGroupResize: () => undefined,
              beginGroupResize: () => undefined,
            }}
          >
            <AnnotationNamesContext.Provider value={NAMES}>
              <AnnotationSticky data={data} nodeId='n1' />
            </AnnotationNamesContext.Provider>
          </CanvasActionsContext.Provider>
        </CanvasContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const note = (over: Partial<AnnotationNodeView> = {}): AnnotationNodeView => ({
  content: 'shorten the opening',
  createdBy: 'u-me',
  createdAt: 1,
  replies: [],
  ...over,
});

/** My hand-over of the note to c1, as the server's record says. */
const mine = (status: 'pending' | 'answered' = 'pending'): Array<Record<string, unknown>> => [{ threadId: 'n1', connectionId: 'c1', assignedAt: 100, status }];

beforeEach(() => {
  useCanvasStore.getState().reset();
  canvasSessions.clear();
  vi.clearAllMocks();
  useCurrentUserStore.setState({ user: { id: 'u-me' } as never });
  api.listConnections.mockResolvedValue([
    { id: 'c1', kind: 'cimd', displayName: 'Claude Code', createdAt: '2026-11-03T00:00:00Z', lastUsedAt: null, status: 'active' },
  ]);
  api.spaceAssignments.mockResolvedValue([]);
  api.connectionNames.mockResolvedValue([{ id: 'c1', name: 'Claude Code' }]);
  sendSpaceCommentRequest.mockImplementation(async (_p: string, _s: string, _k: string, request: object) => ({ id: 'r', ok: true, ...request }));
});

describe('handing a canvas note to an external agent', () => {
  it('asks collab to hand it to the connection picked from the list, then reads the record again', async () => {
    mount(note());
    await userEvent.click(screen.getByTestId('hand-over-open'));
    api.spaceAssignments.mockResolvedValue(mine());
    await userEvent.click(await screen.findByTestId('hand-over-choice-c1'));
    expect(sendSpaceCommentRequest).toHaveBeenCalledWith('p1', 's1', 'canvas', {
      type: 'comment:hand-over',
      payload: { spaceId: 's1', threadId: 'n1', connectionId: 'c1' },
    });
    expect(await screen.findByText('Waiting for Claude Code')).toBeInTheDocument();
  });

  it('says so when collab refuses the hand-over', async () => {
    sendSpaceCommentRequest.mockResolvedValue({ id: 'r', ok: false, error: { code: 'FORBIDDEN', message: 'x' } });
    mount(note());
    await userEvent.click(screen.getByTestId('hand-over-open'));
    await userEvent.click(await screen.findByTestId('hand-over-choice-c1'));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('offers a viewer no button', () => {
    mount(note(), 'viewer');
    expect(screen.queryByTestId('hand-over-open')).toBeNull();
  });

  it('asks collab to take it back', async () => {
    api.spaceAssignments.mockResolvedValue(mine());
    mount(note());
    await userEvent.click(await screen.findByTestId('hand-over-cancel'));
    expect(sendSpaceCommentRequest).toHaveBeenCalledWith('p1', 's1', 'canvas', {
      type: 'comment:cancel-hand-over',
      payload: { spaceId: 's1', threadId: 'n1' },
    });
  });

  it('shows the one who handed it over what it waits for', async () => {
    api.spaceAssignments.mockResolvedValue(mine());
    mount(note());
    expect(await screen.findByText('Waiting for Claude Code')).toBeInTheDocument();
  });

  it('names the agent on its reply, and the wait is over once the record says answered', async () => {
    api.spaceAssignments.mockResolvedValue(mine('answered'));
    mount(note({ replies: [{ id: 'r1', content: 'done', createdBy: 'u-me', createdAt: 2, via: 'c1' }] }));
    expect(await screen.findByText('Claude Code replied')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for Claude Code')).toBeNull();
  });
});
