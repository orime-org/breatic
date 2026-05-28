import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ShareDialog } from '@/pages/project/chrome/top-bar/ShareDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores';
import { ApiException } from '@/data/api/types';

const PID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/data/api/invite-links', () => ({
  inviteLinksApi: {
    create: vi.fn(),
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

function setup() {
  useUIStore.setState({ shareOpen: true });
  return render(
    <TooltipProvider>
      <ShareDialog projectId={PID} />
    </TooltipProvider>,
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
    expect(inviteLinksApi.create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('sends a valid email + role=view + is_permanent=true to the API', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockResolvedValueOnce({
      data: makeFakeLink({ isPermanent: true, role: 'view' }),
    });
    setup();
    await user.type(
      screen.getByTestId('share-invite-input'),
      'new@example.com',
    );
    await user.click(screen.getByTestId('share-send-invite'));

    await waitFor(() => {
      expect(inviteLinksApi.create).toHaveBeenCalledWith(PID, {
        invitee_email: 'new@example.com',
        role: 'view',
        is_permanent: true,
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
});

describe('ShareDialog — sharable link flow', () => {
  it('permanent toggle changes pressed-state when clicked', async () => {
    const user = userEvent.setup();
    setup();
    const toggle = screen.getByTestId('share-permanent-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('Generate link button passes the toggle state as is_permanent (single-use default)', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockResolvedValueOnce({
      data: makeFakeLink({ isPermanent: false }),
    });
    setup();
    await user.click(screen.getByTestId('share-generate-link'));

    await waitFor(() => {
      expect(inviteLinksApi.create).toHaveBeenCalledWith(PID, {
        role: 'view',
        is_permanent: false,
      });
    });
  });

  it('Generate link button passes is_permanent=true after toggle is on', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockResolvedValueOnce({
      data: makeFakeLink({ isPermanent: true }),
    });
    setup();
    await user.click(screen.getByTestId('share-permanent-toggle'));
    await user.click(screen.getByTestId('share-generate-link'));

    await waitFor(() => {
      expect(inviteLinksApi.create).toHaveBeenCalledWith(PID, {
        role: 'view',
        is_permanent: true,
      });
    });
  });

  it('renders generated URL after link creation + copy button is enabled', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteLinksApi.create).mockResolvedValueOnce({
      data: makeFakeLink({ token: 'abc-token-123', isPermanent: true }),
    });
    setup();
    const copy = screen.getByTestId('share-copy-link') as HTMLButtonElement;
    expect(copy).toBeDisabled();
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

// ── helpers ────────────────────────────────────────────────────────

interface FakeLinkOverrides {
  token?: string;
  role?: string;
  isPermanent?: boolean;
}

function makeFakeLink(o: FakeLinkOverrides = {}) {
  return {
    id: 'sl-1',
    projectId: PID,
    createdByUserId: 'u-owner',
    token: o.token ?? 'token-mock',
    role: o.role ?? 'view',
    isPermanent: o.isPermanent ?? false,
    consumedAt: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
}
