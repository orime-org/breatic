// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hand-over controls on a comment thread (#1488 §11.7): the button and
 * its list, the label the one who handed it over sees, and the name on a
 * reply an external agent wrote.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConnectionItem } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { HandOverButton } from '@web/features/comment-handover/HandOverButton';
import { HandOverStatus } from '@web/features/comment-handover/HandOverStatus';
import { ReplyVia } from '@web/features/comment-handover/ReplyVia';
import { useAgentTokensDialog } from '@web/stores/agent-tokens-dialog';

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

/** Where the thread is, as both controls are given it. */
const at = { projectId: 'p1', spaceId: 's1', threadId: 't1', kind: 'canvas' as const };
/** My hand-over of the thread to c1, as the server's record says. */
const mine = (status: 'pending' | 'answered' = 'pending'): Array<Record<string, unknown>> => [{ threadId: 't1', connectionId: 'c1', assignedAt: 100, status }];

/**
 * A connection of mine.
 * @param over - Fields to change.
 * @returns It.
 */
const conn = (over: Partial<AgentConnectionItem> = {}): AgentConnectionItem => ({
  id: 'c1',
  kind: 'cimd',
  displayName: 'Claude Code',
  createdAt: '2026-11-03T00:00:00Z',
  lastUsedAt: null,
  status: 'active',
  ...over,
});

/**
 * Render inside the providers the page gives.
 * @param ui - What to render.
 * @returns The render result.
 */
function mount(ui: React.ReactNode): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listConnections.mockResolvedValue([conn(), conn({ id: 'c2', displayName: 'Cursor' })]);
  api.spaceAssignments.mockResolvedValue([]);
  api.connectionNames.mockResolvedValue([]);
  useAgentTokensDialog.getState().hide();
  sendSpaceCommentRequest.mockResolvedValue({ id: 'r', ok: true });
});

describe('the hand-over button', () => {
  it('asks collab to hand the thread to the connection picked from the list', async () => {
    mount(<HandOverButton {...at} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    await userEvent.click(await screen.findByRole('button', { name: /Cursor/ }));
    expect(sendSpaceCommentRequest).toHaveBeenCalledWith('p1', 's1', 'canvas', {
      type: 'comment:hand-over',
      payload: { spaceId: 's1', threadId: 't1', connectionId: 'c2' },
    });
  });

  it('offers the connection that answered my hand-over first, to hand it again', async () => {
    api.spaceAssignments.mockResolvedValue(mine('answered'));
    mount(<HandOverButton {...at} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    const rows = await screen.findAllByTestId(/^hand-over-choice-/);
    expect(rows.map((r) => r.textContent)).toEqual(['Hand to Claude Code again', 'Cursor']);
  });

  it('lists no expired connection and tells same-named ones apart', async () => {
    api.listConnections.mockResolvedValue([
      conn(),
      conn({ id: 'c4', kind: 'pat', tokenPrefix: 'brt_3f9a' }),
      conn({ id: 'c3', displayName: 'Windsurf', status: 'expired' }),
    ]);
    mount(<HandOverButton {...at} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    expect(await screen.findByText('Token brt_3f9a')).toBeInTheDocument();
    expect(screen.getByText(/^Connected /)).toBeInTheDocument();
    expect(screen.queryByText('Windsurf')).toBeNull();
  });

  it('points to connecting one when there is none', async () => {
    api.listConnections.mockResolvedValue([]);
    mount(<HandOverButton {...at} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    expect(await screen.findByText('No external Agent connected yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect one' }));
    expect(useAgentTokensDialog.getState().open).toBe(true);
  });

  it('offers a retry when the list fails', async () => {
    api.listConnections.mockRejectedValueOnce(new Error('down'));
    mount(<HandOverButton {...at} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Cursor/ })).toBeInTheDocument();
  });

  it('lets the one who handed it over take it back', async () => {
    api.spaceAssignments.mockResolvedValue(mine());
    mount(<HandOverButton {...at} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Take back' }));
    expect(sendSpaceCommentRequest).toHaveBeenCalledWith('p1', 's1', 'canvas', { type: 'comment:cancel-hand-over', payload: { spaceId: 's1', threadId: 't1' } });
  });

  it('offers a take-back to nobody without a record of their own hand-over', async () => {
    mount(<HandOverButton {...at} />);
    await waitFor(() => expect(api.spaceAssignments).toHaveBeenCalledWith('p1', 's1'));
    expect(screen.queryByRole('button', { name: 'Take back' })).toBeNull();
  });
});

describe('the label on a thread handed over', () => {
  const props = { projectId: at.projectId, spaceId: at.spaceId, threadId: at.threadId, open: true };

  beforeEach(() => {
    api.spaceAssignments.mockResolvedValue(mine());
  });

  it('says whom it waits for', async () => {
    mount(<HandOverStatus {...props} />);
    expect(await screen.findByText('Waiting for Claude Code')).toBeInTheDocument();
  });

  it('is gone once the record says the agent answered', async () => {
    api.spaceAssignments.mockResolvedValue(mine('answered'));
    mount(<HandOverStatus {...props} />);
    await waitFor(() => expect(api.spaceAssignments).toHaveBeenCalledWith('p1', 's1'));
    await waitFor(() => expect(screen.queryByTestId('hand-over-status')).toBeNull());
  });

  it('opens the Agent tokens dialog at the expired connection', async () => {
    api.listConnections.mockResolvedValue([conn({ status: 'expired', kind: 'dcr' })]);
    mount(<HandOverStatus {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Claude Code expired, reconnect to continue' }));
    expect(useAgentTokensDialog.getState()).toMatchObject({ open: true, focusId: 'c1' });
  });

  it('says an expired token will not answer', async () => {
    api.listConnections.mockResolvedValue([conn({ status: 'expired', kind: 'pat' })]);
    mount(<HandOverStatus {...props} />);
    expect(await screen.findByText('Claude Code expired, won\'t answer')).toBeInTheDocument();
  });

  it('names a disconnected connection by its kept name', async () => {
    api.listConnections.mockResolvedValue([]);
    api.connectionNames.mockResolvedValue([{ id: 'c1', name: 'Old laptop' }]);
    mount(<HandOverStatus {...props} />);
    expect(await screen.findByText('Old laptop disconnected, won\'t answer')).toBeInTheDocument();
  });

  it('shows nothing to a collaborator, whose records list holds no hand-over of this thread', async () => {
    api.spaceAssignments.mockResolvedValue([]);
    mount(<HandOverStatus {...props} />);
    await waitFor(() => expect(api.spaceAssignments).toHaveBeenCalledWith('p1', 's1'));
    expect(screen.queryByTestId('hand-over-status')).toBeNull();
  });

  it('shows nothing on a thread that is gone or resolved', async () => {
    mount(<HandOverStatus {...props} open={false} />);
    await waitFor(() => expect(api.spaceAssignments).toHaveBeenCalled());
    expect(screen.queryByTestId('hand-over-status')).toBeNull();
  });
});

describe('a reply an external agent wrote', () => {
  it('says which one', async () => {
    api.connectionNames.mockResolvedValue([{ id: 'c9', name: 'Codex' }]);
    mount(<ReplyVia connectionId='c9' />);
    expect(await screen.findByText('Codex replied')).toBeInTheDocument();
  });
});
