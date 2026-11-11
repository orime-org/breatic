// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1400 — the Project instructions entry in the Agent panel header.
 *
 * It sits between the conversation name and the new-conversation button,
 * says what it is in a tooltip, and carries a dot exactly while the Project
 * has instructions: the read came back with text in it. An empty text, a read
 * still in flight and a failed read all show no dot.
 */

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { t, type AgentInstructionsView } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { apiGet } from '@web/data/api/request';
import { AgentColHeader } from '@web/pages/project/chrome/agent-header/AgentColHeader';
import { AgentInstructionsButton } from '@web/pages/project/chrome/agent-header/AgentInstructionsButton';

const PROJECT = 'p-1';
const WRITTEN: AgentInstructionsView = {
  text: 'Answer in English.',
  updatedBy: 'Mei Tan',
  updatedAt: '2026-11-08T08:02:00.000Z',
};
const EMPTY: AgentInstructionsView = { text: '', updatedBy: null, updatedAt: null };

const mockGet = vi.mocked(apiGet);

/**
 * Wrap a tree in the providers the Project page gives it.
 * @param ui - The tree.
 * @returns The wrapped tree.
 */
function withProviders(ui: React.ReactElement): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(EMPTY);
});

describe('the Project instructions entry in the Agent header (#1400)', () => {
  it('sits between the conversation name and the new-conversation button', () => {
    render(
      withProviders(
        <AgentColHeader
          projectId={PROJECT}
          conversationName='Onboarding'
          conversationNamePlaceholder='Untitled conversation'
          onToggleHistory={vi.fn()}
          onNewConversation={vi.fn()}
          creating={false}
          onRenameConversation={vi.fn()}
        />,
      ),
    );
    const header = screen.getByTestId('agent-col-header');
    const title = screen.getByTestId('title-display');
    const entry = screen.getByTestId('agent-instructions-open');
    const plus = screen.getByTestId('new-conversation');

    expect(header).toContainElement(entry);
    expect(title.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(entry.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names itself in a tooltip', async () => {
    render(withProviders(<AgentInstructionsButton projectId={PROJECT} />));
    const entry = screen.getByTestId('agent-instructions-open');
    fireEvent.pointerMove(entry, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(t('chat.instructions.open'));
    expect(t('chat.instructions.open')).not.toBe('chat.instructions.open');
  });

  it('reads the instructions of its own Project', async () => {
    render(withProviders(<AgentInstructionsButton projectId={PROJECT} />));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    const [url, config] = mockGet.mock.calls[0]!;
    const address = new URL(url, 'http://api.test');
    const params = (config?.params ?? {}) as Record<string, string>;
    expect(address.pathname).toBe('/chat/instructions');
    expect(address.searchParams.get('project_id') ?? params.project_id).toBe(PROJECT);
  });

  it('shows the dot when the Project has instructions', async () => {
    mockGet.mockResolvedValue(WRITTEN);
    render(withProviders(<AgentInstructionsButton projectId={PROJECT} />));
    expect(await screen.findByTestId('agent-instructions-dot')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instructions-open')).toContainElement(
      screen.getByTestId('agent-instructions-dot'),
    );
  });

  it('shows no dot when the instructions are empty', async () => {
    mockGet.mockResolvedValue(EMPTY);
    render(withProviders(<AgentInstructionsButton projectId={PROJECT} />));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    // Let the answer land before judging the dot.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('agent-instructions-open')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-instructions-dot')).toBeNull();
  });

  it('shows no dot while the read is in flight', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(withProviders(<AgentInstructionsButton projectId={PROJECT} />));
    expect(screen.getByTestId('agent-instructions-open')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-instructions-dot')).toBeNull();
  });

  it('shows no dot when the read failed', async () => {
    mockGet.mockRejectedValue(new Error('offline'));
    render(withProviders(<AgentInstructionsButton projectId={PROJECT} />));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('agent-instructions-open')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-instructions-dot')).toBeNull();
  });
});
