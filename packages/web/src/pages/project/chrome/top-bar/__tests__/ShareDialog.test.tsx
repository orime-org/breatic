import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { ShareDialog } from '@/pages/project/chrome/top-bar/ShareDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores';
import { ApiException } from '@/data/api/types';

const PID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/data/api/invite-links', () => ({
  inviteLinksApi: {
    create: vi.fn(),
    listByProject: vi.fn().mockResolvedValue({ data: [] }),
    revoke: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

import { inviteLinksApi } from '@/data/api/invite-links';
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
  vi.mocked(inviteLinksApi.listByProject).mockResolvedValue({ data: [] });
});

describe('ShareDialog — invite by email flow', () => {
  it('rejects an invalid email format inline (does NOT call API)', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByTestId('share-invite-input'), 'not-an-email');
    await user.click(screen.getByTestId('share-send-invite'));
    expect(inviteLinksApi.create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('sends a valid email + role=view (default) to the API', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockResolvedValueOnce({
      data: makeFakeLink({ kind: 'email', boundEmail: 'new@example.com', role: 'view' }),
    });
    setup();
    await user.type(
      screen.getByTestId('share-invite-input'),
      'new@example.com',
    );
    await user.click(screen.getByTestId('share-send-invite'));

    await waitFor(() => {
      expect(inviteLinksApi.create).toHaveBeenCalledWith(PID, {
        kind: 'email',
        invitee_email: 'new@example.com',
        role: 'view',
      });
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows ApiException.message inline when send invite is rejected', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockRejectedValueOnce(
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

  it('disables the invite section when emailEnabled=false + shows hint', async () => {
    setup({ emailEnabled: false });
    expect(screen.getByTestId('share-email-disabled-hint')).toBeInTheDocument();
    expect(screen.getByTestId('share-invite-input')).toBeDisabled();
    expect(screen.getByTestId('share-send-invite')).toBeDisabled();
  });
});

describe('ShareDialog — Generate link flow', () => {
  it('Generate button calls API with kind=link + no invitee_email', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockResolvedValueOnce({
      data: makeFakeLink({ kind: 'link', boundEmail: null }),
    });
    setup();
    await user.click(screen.getByTestId('share-generate-link'));

    await waitFor(() => {
      expect(inviteLinksApi.create).toHaveBeenCalledWith(PID, {
        kind: 'link',
        role: 'view',
      });
    });
  });

  it('renders generated URL after link creation + copy button is enabled', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockResolvedValueOnce({
      data: makeFakeLink({ kind: 'link', token: 'abc-token-123', boundEmail: null }),
    });
    setup();
    // URL/copy not visible before generate
    expect(screen.queryByTestId('share-invite-url')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('share-generate-link'));

    await waitFor(() => {
      const url = screen.getByTestId('share-invite-url') as HTMLInputElement;
      expect(url.value).toContain('/invite/abc-token-123');
    });
    expect(screen.getByTestId('share-copy-link')).not.toBeDisabled();
  });

  it('toasts error when Generate link rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockRejectedValueOnce(
      new ApiException({
        status: 500,
        code: 'INTERNAL',
        message: 'oops',
      }),
    );
    setup();
    await user.click(screen.getByTestId('share-generate-link'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('oops');
    });
  });
});

describe('ShareDialog — view all links entry', () => {
  it('renders the "View all generated links" button', () => {
    setup();
    expect(screen.getByTestId('share-view-all-links')).toBeInTheDocument();
  });

  it('reflects the count from listByProject in the button label', async () => {
    vi.mocked(inviteLinksApi.listByProject).mockResolvedValueOnce({
      data: [makeFakeLink({}), makeFakeLink({ token: 'b' })],
    });
    setup();
    const button = screen.getByTestId('share-view-all-links');
    await waitFor(() => {
      expect(button.textContent).toMatch(/2/);
    });
  });
});

// ── helpers ────────────────────────────────────────────────────────

interface FakeLinkOverrides {
  token?: string;
  role?: string;
  kind?: 'email' | 'link';
  boundEmail?: string | null;
}

function makeFakeLink(o: FakeLinkOverrides = {}) {
  // Default to a kind consistent with the boundEmail override so each
  // test doesn't have to spell out both.
  const boundEmail = o.boundEmail ?? null;
  const kind = o.kind ?? (boundEmail !== null ? 'email' : 'link');
  return {
    id: 'sl-1',
    projectId: PID,
    createdByUserId: 'u-owner',
    token: o.token ?? 'token-mock',
    role: o.role ?? 'view',
    kind,
    boundEmail,
    consumedAt: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
}
