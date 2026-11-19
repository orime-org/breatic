// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Handing a canvas note to an external agent (#1488 §11.7): the button on
 * the note, what it writes, the label and the name on the agent's reply.
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

const setAnnotationAssignment = vi.fn();

vi.mock('@web/data/yjs/canvas-space', () => ({
  addReply: () => true,
  editAnnotationBody: () => true,
  editReply: () => true,
  removeReply: () => undefined,
  setAnnotationAssignment: (...a: unknown[]) => setAnnotationAssignment(...a),
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

const handed = { connectionId: 'c1', assignedBy: 'u-me', assignedAt: 100, projectId: 'p1' };

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
});

describe('handing a canvas note to an external agent', () => {
  it('writes the hand-over picked from the list', async () => {
    mount(note());
    await userEvent.click(screen.getByTestId('hand-over-open'));
    await userEvent.click(await screen.findByTestId('hand-over-choice-c1'));
    expect(setAnnotationAssignment).toHaveBeenCalledWith(
      'p1',
      's1',
      'n1',
      expect.objectContaining({ connectionId: 'c1', assignedBy: 'u-me', projectId: 'p1' }),
    );
  });

  it('offers a viewer no button', () => {
    mount(note(), 'viewer');
    expect(screen.queryByTestId('hand-over-open')).toBeNull();
  });

  it('takes it back', async () => {
    mount(note({ assignment: handed }));
    await userEvent.click(screen.getByTestId('hand-over-cancel'));
    expect(setAnnotationAssignment).toHaveBeenCalledWith('p1', 's1', 'n1', null);
  });

  it('shows the one who handed it over what it waits for', async () => {
    mount(note({ assignment: handed }));
    expect(await screen.findByText('Waiting for Claude Code')).toBeInTheDocument();
  });

  it('names the agent on its reply, and the wait is over', async () => {
    mount(
      note({
        assignment: handed,
        replies: [{ id: 'r1', content: 'done', createdBy: 'u-me', createdAt: 2, via: 'c1', answers: 100 }],
      }),
    );
    expect(await screen.findByText('Claude Code replied')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for Claude Code')).toBeNull();
  });
});
