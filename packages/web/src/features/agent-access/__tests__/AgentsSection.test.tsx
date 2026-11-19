// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentConnectionItem } from '@breatic/shared';

import { AgentsSection } from '@web/features/agent-access/AgentsSection';
import { ApiException } from '@web/data/api/types';
import { TooltipProvider } from '@web/components/ui/tooltip';

vi.mock('@web/data/api/agent-access', () => ({
  AGENT_CONNECTIONS_KEY: ['agent-access', 'connections'],
  agentAccessApi: { listConnections: vi.fn(), rename: vi.fn(), disconnect: vi.fn(), createToken: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { agentAccessApi } from '@web/data/api/agent-access';
import { toast } from '@web/lib/toast';

const CLAUDE: AgentConnectionItem = { id: 'c1', kind: 'dcr', displayName: 'Claude Code', createdAt: '2026-11-10T08:00:00Z', lastUsedAt: '2026-11-18T08:00:00Z', status: 'active' };
const CODEX: AgentConnectionItem = { id: 'c2', kind: 'cimd', displayName: 'Codex', createdAt: '2026-11-01T08:00:00Z', lastUsedAt: null, status: 'expired' };
const TOKEN: AgentConnectionItem = {
  id: 'c3',
  kind: 'pat',
  displayName: 'CI runner',
  createdAt: '2026-11-02T08:00:00Z',
  lastUsedAt: null,
  status: 'active',
  tokenPrefix: 'brt_abcd',
  expiresAt: '2027-02-02T08:00:00Z',
};

/**
 * Render the section with a fresh query client.
 * @param focusId - The connection to scroll to and mark.
 * @returns Nothing.
 */
function renderSection(focusId?: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AgentsSection {...(focusId === undefined ? {} : { focusId })} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(agentAccessApi.listConnections).mockReset().mockResolvedValue([CLAUDE, CODEX, TOKEN]);
  vi.mocked(agentAccessApi.rename).mockReset();
  vi.mocked(agentAccessApi.disconnect).mockReset();
  vi.mocked(agentAccessApi.createToken).mockReset();
  vi.mocked(toast.error).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentsSection', () => {
  it('lists OAuth clients and personal access tokens apart, marking the expired', async () => {
    renderSection();
    const clients = await screen.findByTestId('agents-clients');
    expect(within(clients).getByText('Claude Code')).toBeInTheDocument();
    expect(within(clients).getByText('Codex')).toBeInTheDocument();
    expect(within(clients).getByText('Expired')).toBeInTheDocument();
    expect(within(clients).getByText(/Connect again from Codex/)).toBeInTheDocument();
    const tokens = screen.getByTestId('agents-tokens');
    expect(within(tokens).getByText('CI runner')).toBeInTheDocument();
    expect(within(tokens).getByText(/brt_abcd…/)).toBeInTheDocument();
  });

  it('shows each list empty with what fills it', async () => {
    vi.mocked(agentAccessApi.listConnections).mockResolvedValue([]);
    renderSection();
    expect(await screen.findByText(/No external Agent has connected yet/)).toBeInTheDocument();
    expect(screen.getByText(/^No tokens\./)).toBeInTheDocument();
  });

  it('offers a retry when the list cannot load', async () => {
    vi.mocked(agentAccessApi.listConnections).mockRejectedValueOnce(new ApiException({ status: 500, code: 'INTERNAL', message: 'boom' }));
    renderSection();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Retry' }))[0]!);
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
  });

  it('renames a connection, and will not save a blank name', async () => {
    vi.mocked(agentAccessApi.rename).mockResolvedValue({ id: 'c1', name: 'My laptop' });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Claude Code' }));
    const input = screen.getByRole('textbox', { name: 'Rename' });
    await userEvent.clear(input);
    expect(screen.getByText('Enter a name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.type(input, 'My laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(agentAccessApi.rename).toHaveBeenCalledWith('c1', 'My laptop');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument());
  });

  it('keeps the name being edited and says so when a rename fails', async () => {
    vi.mocked(agentAccessApi.rename).mockRejectedValue(new ApiException({ status: 500, code: 'INTERNAL', message: 'boom' }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Claude Code' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Rename' }), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not rename. Try again later.'));
    expect(screen.getByRole('textbox', { name: 'Rename' })).toHaveValue('Claude Code 2');
  });

  it('disconnects an active client after confirming, and removes an expired one', async () => {
    vi.mocked(agentAccessApi.disconnect).mockResolvedValue();
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(screen.getByText('Disconnect Claude Code?')).toBeInTheDocument();
    vi.mocked(agentAccessApi.listConnections).mockResolvedValue([CODEX, TOKEN]);
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    expect(agentAccessApi.disconnect).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(screen.queryByText('Claude Code')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove Codex?')).toBeInTheDocument();
  });

  it('keeps the confirmation open and says so when disconnecting fails', async () => {
    vi.mocked(agentAccessApi.disconnect).mockRejectedValue(new ApiException({ status: 500, code: 'INTERNAL', message: 'boom' }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Revoke failed. Try again later.'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('creates a token and shows its plaintext once', async () => {
    vi.mocked(agentAccessApi.createToken).mockResolvedValue({ token: 'brt_secretvalue', connectionId: 'c9' });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'New token' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Generate' })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Server');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(agentAccessApi.createToken).toHaveBeenCalledWith('Server', 90);
    expect(await within(dialog).findByText('brt_secretvalue')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('brt_secretvalue')).not.toBeInTheDocument();
  });

  it('says the server\'s reason when no more tokens may be created', async () => {
    vi.mocked(agentAccessApi.createToken).mockRejectedValue(
      new ApiException({ status: 409, code: 'CONFLICT', message: 'You have 20 active tokens; revoke one first.', fromServer: true }),
    );
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'New token' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'One more');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('You have 20 active tokens; revoke one first.'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('marks the connection a comment label opened the page for', async () => {
    renderSection('c2');
    await screen.findByText('Codex');
    expect(screen.getByTestId('agent-row-c2')).toHaveAttribute('data-focused', 'true');
    expect(screen.getByTestId('agent-row-c1')).not.toHaveAttribute('data-focused');
  });
});
