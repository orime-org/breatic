// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Handing a document comment to an external agent (#1488 §11.7): the button
 * in the card's header while it is read, the label the server's record
 * decides, and the agent's name on its reply.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { DocumentCommentCard } from '@web/spaces/document/DocumentCommentCard';
import type { CommentCardView, CommentEntryView } from '@web/spaces/document/use-comment-cards';

const api = vi.hoisted(() => ({
  listConnections: vi.fn(),
  spaceAssignments: vi.fn(),
  connectionNames: vi.fn(),
}));

const sendSpaceCommentRequest = vi.hoisted(() => vi.fn());

vi.mock('@web/data/yjs/comment-requests', async (real) => ({
  ...(await real<typeof import('@web/data/yjs/comment-requests')>()),
  sendSpaceCommentRequest,
}));

vi.mock('@web/data/api/agent-access', async (real) => ({
  ...(await real<typeof import('@web/data/api/agent-access')>()),
  agentAccessApi: api,
}));

vi.mock('@web/data/use-project-members', () => ({
  useProjectMembers: () => ({ members: [], isLoading: false, isError: false, retry: () => undefined }),
}));

const ME = 'u1';
/** My hand-over of the thread to c1, as the server's record says. */
const mine = (status: 'pending' | 'answered' = 'pending'): Array<Record<string, unknown>> => [{ threadId: 't1', connectionId: 'c1', assignedAt: 100, status }];

/**
 * One comment.
 * @param over - Fields to change.
 * @returns It.
 */
const entry = (over: Partial<CommentEntryView> = {}): CommentEntryView => ({
  id: 'e1',
  author: 'Mika',
  authorId: ME,
  avatarUrl: null,
  body: 'shorten this',
  createdAt: new Date(0),
  fromAgent: false,
  via: null,
  ...over,
});

/**
 * A card on the panel.
 * @param over - Fields to change.
 * @returns It.
 */
const card = (over: Partial<CommentCardView> = {}): CommentCardView => ({
  id: 't1',
  settled: false,
  quote: 'the opening',
  media: null,
  entries: [entry()],
  ...over,
});


/**
 * Draw a card.
 * @param view - The card.
 * @param reading - Whether it is the one being read.
 * @param myRole - The viewer's role.
 */
function mount(view: CommentCardView, reading = true, myRole: 'editor' | 'viewer' = 'editor'): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <DocumentCommentCard
          card={view}
          marked={false}
          reading={reading}
          myRole={myRole}
          viewerId={ME}
          draft=''
          onDraft={vi.fn()}
          onReply={vi.fn(async () => true)}
          onResolve={vi.fn()}
          onReopen={vi.fn()}
          onDelete={vi.fn()}
          onDeleteReply={vi.fn()}
          projectId='p1'
          spaceId='s1'
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listConnections.mockResolvedValue([
    { id: 'c1', kind: 'cimd', displayName: 'Claude Code', createdAt: '2026-11-03T00:00:00Z', lastUsedAt: null, status: 'active' },
  ]);
  api.spaceAssignments.mockResolvedValue([]);
  api.connectionNames.mockResolvedValue([{ id: 'c1', name: 'Claude Code' }]);
  sendSpaceCommentRequest.mockResolvedValue({ id: 'r', ok: true });
});

describe('handing a document comment to an external agent', () => {
  it('hands the thread over from the card being read', async () => {
    mount(card());
    await userEvent.click(screen.getByTestId('hand-over-open'));
    await userEvent.click(await screen.findByTestId('hand-over-choice-c1'));
    expect(sendSpaceCommentRequest).toHaveBeenCalledWith('p1', 's1', 'document', {
      type: 'comment:hand-over',
      payload: { spaceId: 's1', threadId: 't1', connectionId: 'c1' },
    });
  });

  it('offers no button on a card nobody is reading, nor to a viewer', () => {
    mount(card(), false);
    expect(screen.queryByTestId('hand-over-open')).toBeNull();
  });

  it('offers a viewer no button', () => {
    mount(card(), true, 'viewer');
    expect(screen.queryByTestId('hand-over-open')).toBeNull();
  });

  it('offers no button on a resolved thread', () => {
    mount(card({ settled: true }));
    expect(screen.queryByTestId('hand-over-open')).toBeNull();
  });

  it('takes it back', async () => {
    api.spaceAssignments.mockResolvedValue(mine());
    mount(card());
    await userEvent.click(await screen.findByTestId('hand-over-cancel'));
    expect(sendSpaceCommentRequest).toHaveBeenCalledWith('p1', 's1', 'document', { type: 'comment:cancel-hand-over', payload: { spaceId: 's1', threadId: 't1' } });
  });

  it('shows the one who handed it over what it waits for, even while the card is not read', async () => {
    api.spaceAssignments.mockResolvedValue(mine());
    mount(card(), false);
    expect(await screen.findByText('Waiting for Claude Code')).toBeInTheDocument();
  });

  it('stops waiting once the thread is resolved', async () => {
    api.spaceAssignments.mockResolvedValue(mine());
    mount(card({ settled: true }), false);
    await waitFor(() => {
      expect(api.listConnections).toHaveBeenCalled();
      expect(api.spaceAssignments).toHaveBeenCalled();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('Waiting for Claude Code')).toBeNull();
  });

  it('names the agent on its reply, and the wait is over once the record says answered', async () => {
    api.spaceAssignments.mockResolvedValue(mine('answered'));
    mount(card({ entries: [entry(), entry({ id: 'e2', via: 'c1' })] }));
    expect(await screen.findByText('Claude Code replied')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for Claude Code')).toBeNull();
  });
});
