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

const PROJECT = { id: 'p1', name: 'Autumn Film', studioSlug: 'acme', archivedAt: null };

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
    const send = screen.getByRole('button', { name: 'Request to join' });
    expect(send).toHaveAttribute('aria-busy', 'true');
    expect(send).toHaveAttribute('aria-disabled', 'true');
    sent.resolve();
    expect(await screen.findByText('Request sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });

  it('stays on the form and shows the error when sending fails', async () => {
    mine.mockResolvedValue({ project: PROJECT, pendingRequest: null });
    const sent = deferred<void>();
    request.mockReturnValue(sent.promise);
    renderDialog();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Request to join' })).toBeEnabled());
    const send = screen.getByRole('button', { name: 'Request to join' });
    await user.click(send);
    expect(send).toHaveAttribute('aria-busy', 'true');

    sent.reject(new Error('boom'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('aria-busy');
    expect(send).not.toHaveAttribute('aria-disabled');
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
    const withdraw = screen.getByRole('button', { name: 'Withdraw request' });
    expect(withdraw).toHaveAttribute('aria-busy', 'true');
    expect(withdraw).toHaveAttribute('aria-disabled', 'true');

    withdrawn.resolve();
    expect(await screen.findByRole('button', { name: 'Request to join' })).toBeEnabled();
  });

  it('stays on the pending state and shows the error when withdrawing fails', async () => {
    mine.mockResolvedValue({
      project: PROJECT,
      pendingRequest: { id: 'r1', createdAt: '2026-09-28T02:00:00.000Z' },
    });
    const withdrawn = deferred<void>();
    cancelMine.mockReturnValue(withdrawn.promise);
    renderDialog();
    const user = userEvent.setup();

    const withdraw = await screen.findByRole('button', { name: 'Withdraw request' });
    await user.click(withdraw);
    expect(withdraw).toHaveAttribute('aria-busy', 'true');

    withdrawn.reject(new Error('boom'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByText('Request pending')).toBeInTheDocument();
    expect(withdraw).toBeEnabled();
    expect(withdraw).not.toHaveAttribute('aria-busy');
    expect(withdraw).not.toHaveAttribute('aria-disabled');
  });

  it('closes and shows the error when reading fails', async () => {
    mine.mockRejectedValue(new Error('boom'));
    const { onOpenChange } = renderDialog();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says an archived project takes no requests, with no form to fill', async () => {
    mine.mockResolvedValue({
      project: { ...PROJECT, archivedAt: '2026-10-01T00:00:00.000Z' },
      pendingRequest: null,
    });
    const { onOpenChange } = renderDialog();
    const user = userEvent.setup();

    expect(await screen.findByText('This project is archived')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Autumn Film' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request to join' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'OK' }));
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

