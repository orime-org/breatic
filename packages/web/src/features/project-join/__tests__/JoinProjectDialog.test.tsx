// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { JoinProjectDialog } from '@web/features/project-join/JoinProjectDialog';
import type { MyJoinRequest } from '@web/data/api/project-join-requests';

const mine = vi.fn<(projectId: string) => Promise<MyJoinRequest>>();
const request = vi.fn<(projectId: string, message?: string) => Promise<void>>();
const cancelMine = vi.fn<(projectId: string) => Promise<void>>();
vi.mock('@web/data/api/project-join-requests', () => ({
  projectJoinRequestsApi: {
    mine: (id: string) => mine(id),
    request: (id: string, message?: string) => request(id, message),
    cancelMine: (id: string) => cancelMine(id),
  },
}));

const toastError = vi.fn();
vi.mock('@web/lib/toast', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const PROJECT = { id: 'p1', name: 'Autumn Film', studioSlug: 'acme' };

/**
 * A promise the test settles by hand.
 * @returns The promise and its resolvers.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Render the dialog open, as a card click or a direct link would.
 * @param onOpenChange - Close callback.
 * @returns The render result.
 */
function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <JoinProjectDialog projectId='p1' open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JoinProjectDialog', () => {
  it('holds the request button while it reads whether a request is pending', async () => {
    const read = deferred<MyJoinRequest>();
    mine.mockReturnValue(read.promise);
    renderDialog();

    expect(screen.getByText('You\'re not a member of this project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request to join' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    read.resolve({ project: PROJECT, pendingRequest: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request to join' })).toBeEnabled());
    expect(screen.getByText(/Autumn Film/)).toBeInTheDocument();
  });

  it('sends the request with the message and says it was sent', async () => {
    mine.mockResolvedValue({ project: PROJECT, pendingRequest: null });
    const sent = deferred<void>();
    request.mockReturnValue(sent.promise);
    renderDialog();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Request to join' })).toBeEnabled());
    await user.type(screen.getByLabelText('Message to the owner (optional)'), 'I cut the trailer');
    await user.click(screen.getByRole('button', { name: 'Request to join' }));

    expect(request).toHaveBeenCalledWith('p1', 'I cut the trailer');
    expect(screen.getByRole('button', { name: 'Request to join' })).toBeDisabled();
    sent.resolve();
    expect(await screen.findByText('Request sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });

  it('stays on the form and shows the error when sending fails', async () => {
    mine.mockResolvedValue({ project: PROJECT, pendingRequest: null });
    request.mockRejectedValue(new Error('boom'));
    renderDialog();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Request to join' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Request to join' }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Request to join' })).toBeEnabled();
  });

  it('shows a pending request and lets the requester withdraw it', async () => {
    mine.mockResolvedValue({
      project: PROJECT,
      pendingRequest: { id: 'r1', createdAt: '2026-09-28T02:00:00.000Z' },
    });
    const withdrawn = deferred<void>();
    cancelMine.mockReturnValue(withdrawn.promise);
    renderDialog();
    const user = userEvent.setup();

    expect(await screen.findByText('Request pending')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Withdraw request' }));
    expect(cancelMine).toHaveBeenCalledWith('p1');
    expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeDisabled();

    withdrawn.resolve();
    expect(await screen.findByRole('button', { name: 'Request to join' })).toBeEnabled();
  });

  it('stays on the pending state and shows the error when withdrawing fails', async () => {
    mine.mockResolvedValue({
      project: PROJECT,
      pendingRequest: { id: 'r1', createdAt: '2026-09-28T02:00:00.000Z' },
    });
    cancelMine.mockRejectedValue(new Error('boom'));
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Withdraw request' }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByText('Request pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeEnabled();
  });

  it('closes and shows the error when reading fails', async () => {
    mine.mockRejectedValue(new Error('boom'));
    const { onOpenChange } = renderDialog();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on Cancel', async () => {
    mine.mockResolvedValue({ project: PROJECT, pendingRequest: null });
    const { onOpenChange } = renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

