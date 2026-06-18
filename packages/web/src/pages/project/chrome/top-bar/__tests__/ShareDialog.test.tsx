// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { ShareDialog } from '@web/pages/project/chrome/top-bar/ShareDialog';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useUIStore } from '@web/stores';
import { ApiException } from '@web/data/api/types';

const PID = '11111111-1111-4111-8111-111111111111';

vi.mock('@web/data/api/project-invitations', () => ({
  projectInvitationsApi: {
    getInvitation: vi.fn(),
    respondInvitation: vi.fn(),
    inviteMember: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

import { projectInvitationsApi } from '@web/data/api/project-invitations';
import { toast } from 'sonner';

function AllProviders({ children }: { children: React.ReactNode }) {
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

function setup(props: Partial<React.ComponentProps<typeof ShareDialog>> = {}) {
  useUIStore.setState({ shareOpen: true });
  return render(
    <AllProviders>
      <ShareDialog projectId={PID} {...props} />
    </AllProviders>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ShareDialog — invite by email flow', () => {
  it('rejects an invalid email format inline (does NOT call API)', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByTestId('share-invite-input'), 'not-an-email');
    await user.click(screen.getByTestId('share-send-invite'));
    expect(projectInvitationsApi.inviteMember).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('sends a valid email + role=viewer (default) to the new invitations endpoint', async () => {
    const user = userEvent.setup();
    vi.mocked(projectInvitationsApi.inviteMember).mockResolvedValueOnce({
      ok: true,
    });
    setup();
    await user.type(
      screen.getByTestId('share-invite-input'),
      'new@example.com',
    );
    await user.click(screen.getByTestId('share-send-invite'));

    await waitFor(() => {
      expect(projectInvitationsApi.inviteMember).toHaveBeenCalledWith(PID, {
        email: 'new@example.com',
        role: 'viewer',
      });
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows ApiException.message inline when the invite is rejected', async () => {
    const user = userEvent.setup();
    vi.mocked(projectInvitationsApi.inviteMember).mockRejectedValueOnce(
      new ApiException({
        status: 409,
        code: 'CONFLICT',
        message: 'Already a member',
      }),
    );
    setup();
    await user.type(
      screen.getByTestId('share-invite-input'),
      'new@example.com',
    );
    await user.click(screen.getByTestId('share-send-invite'));

    expect(await screen.findByText(/Already a member/)).toBeInTheDocument();
  });
});

describe('ShareDialog — no public / copy-link control', () => {
  it('does not render the public-link generate / copy / view-all controls', () => {
    setup();
    // The whole public-link mode was removed (#1337): the dialog is invite-only.
    expect(screen.queryByTestId('share-generate-link')).toBeNull();
    expect(screen.queryByTestId('share-copy-link')).toBeNull();
    expect(screen.queryByTestId('share-invite-url')).toBeNull();
    expect(screen.queryByTestId('share-view-all-links')).toBeNull();
    expect(screen.queryByTestId('share-email-disabled-hint')).toBeNull();
  });

  it('keeps the invite section enabled regardless of SMTP config', () => {
    // The bell notification is the always-delivered path; email is best-effort,
    // so the invite controls are never disabled by an email-config flag.
    setup();
    expect(screen.getByTestId('share-invite-input')).not.toBeDisabled();
    expect(screen.getByTestId('share-invite-input')).toHaveValue('');
  });
});
