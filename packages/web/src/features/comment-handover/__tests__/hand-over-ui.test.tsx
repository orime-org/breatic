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

import type { AgentConnectionItem, AnnotationAssignment } from '@breatic/shared';
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

vi.mock('@web/data/api/agent-access', async (real) => ({
  ...(await real<typeof import('@web/data/api/agent-access')>()),
  agentAccessApi: api,
}));

const ME = 'u1';
const handed: AnnotationAssignment = { connectionId: 'c1', assignedBy: ME, assignedAt: 100, projectId: 'p1' };

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
});

describe('the hand-over button', () => {
  it('hands the thread to the connection picked from the list', async () => {
    const onAssign = vi.fn();
    mount(<HandOverButton viewerId={ME} answered={false} onAssign={onAssign} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    await userEvent.click(await screen.findByRole('button', { name: /Cursor/ }));
    expect(onAssign).toHaveBeenCalledWith('c2');
  });

  it('offers the connection that just answered first, to hand it again', async () => {
    mount(<HandOverButton assignment={handed} viewerId={ME} answered onAssign={vi.fn()} onCancel={vi.fn()} />);
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
    mount(<HandOverButton viewerId={ME} answered={false} onAssign={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    expect(await screen.findByText('Token brt_3f9a')).toBeInTheDocument();
    expect(screen.getByText(/^Connected /)).toBeInTheDocument();
    expect(screen.queryByText('Windsurf')).toBeNull();
  });

  it('points to connecting one when there is none', async () => {
    api.listConnections.mockResolvedValue([]);
    mount(<HandOverButton viewerId={ME} answered={false} onAssign={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    expect(await screen.findByText('No external Agent connected yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect one' }));
    expect(useAgentTokensDialog.getState().open).toBe(true);
  });

  it('offers a retry when the list fails', async () => {
    api.listConnections.mockRejectedValueOnce(new Error('down'));
    mount(<HandOverButton viewerId={ME} answered={false} onAssign={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hand to' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Cursor/ })).toBeInTheDocument();
  });

  it('lets the one who handed it over take it back', async () => {
    const onCancel = vi.fn();
    mount(<HandOverButton assignment={handed} viewerId={ME} answered={false} onAssign={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Take back' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('offers nobody else a take-back', () => {
    mount(<HandOverButton assignment={handed} viewerId='u2' answered={false} onAssign={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Take back' })).toBeNull();
  });
});

describe('the label on a thread handed over', () => {
  const props = { projectId: 'p1', spaceId: 's1', threadId: 't1', viewerId: ME, answered: false, resolved: false };

  it('says whom it waits for', async () => {
    mount(<HandOverStatus {...props} assignment={handed} />);
    expect(await screen.findByText('Waiting for Claude Code')).toBeInTheDocument();
  });

  it('is gone once the record says the agent answered', async () => {
    api.spaceAssignments.mockResolvedValue([{ threadId: 't1', connectionId: 'c1', assignedAt: 100, status: 'answered' }]);
    mount(<HandOverStatus {...props} assignment={handed} />);
    await waitFor(() => expect(api.spaceAssignments).toHaveBeenCalledWith('p1', 's1'));
    await waitFor(() => expect(screen.queryByTestId('hand-over-status')).toBeNull());
  });

  it('opens the Agent tokens dialog at the expired connection', async () => {
    api.listConnections.mockResolvedValue([conn({ status: 'expired', kind: 'dcr' })]);
    mount(<HandOverStatus {...props} assignment={handed} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Claude Code expired, reconnect to continue' }));
    expect(useAgentTokensDialog.getState()).toMatchObject({ open: true, focusId: 'c1' });
  });

  it('says an expired token will not answer', async () => {
    api.listConnections.mockResolvedValue([conn({ status: 'expired', kind: 'pat' })]);
    mount(<HandOverStatus {...props} assignment={handed} />);
    expect(await screen.findByText('Claude Code expired, won\'t answer')).toBeInTheDocument();
  });

  it('names a disconnected connection by its kept name', async () => {
    api.listConnections.mockResolvedValue([]);
    api.connectionNames.mockResolvedValue([{ id: 'c1', name: 'Old laptop' }]);
    mount(<HandOverStatus {...props} assignment={handed} />);
    expect(await screen.findByText('Old laptop disconnected, won\'t answer')).toBeInTheDocument();
  });

  it('shows nothing to a collaborator', () => {
    mount(<HandOverStatus {...props} viewerId='u2' assignment={handed} />);
    expect(screen.queryByTestId('hand-over-status')).toBeNull();
    expect(api.spaceAssignments).not.toHaveBeenCalled();
  });
});

describe('a reply an external agent wrote', () => {
  it('says which one', async () => {
    api.connectionNames.mockResolvedValue([{ id: 'c9', name: 'Codex' }]);
    mount(<ReplyVia connectionId='c9' />);
    expect(await screen.findByText('Codex replied')).toBeInTheDocument();
  });
});
