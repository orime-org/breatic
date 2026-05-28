import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { BellMenu } from '@/pages/project/chrome/top-bar/BellMenu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiException } from '@/data/api/types';

const PID = '11111111-1111-4111-8111-111111111111';
const REQ1 = '22222222-2222-4222-8222-222222222222';
const REQ2 = '33333333-3333-4333-8333-333333333333';

vi.mock('@/data/api/access-requests', () => ({
  accessRequestsApi: {
    listPendingByProject: vi.fn(),
    decide: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

import { accessRequestsApi } from '@/data/api/access-requests';
import { toast } from 'sonner';

function setup() {
  // Fresh QueryClient per test so cache + mutation state don't leak.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <BellMenu projectId={PID} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function fakePending(
  id: string,
  role: 'view' | 'edit',
  message: string | null = null,
  status: 'pending' | 'approved' | 'rejected' = 'pending',
) {
  return {
    id,
    projectId: PID,
    requesterUserId: `req-user-${id}`,
    requestedRole: role,
    message,
    status,
    reviewedByUserId: null,
    reviewedAt: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BellMenu — empty list', () => {
  it('shows empty-state copy when there are no pending requests', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.listPendingByProject).mockResolvedValueOnce({
      data: [],
    });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    expect(await screen.findByTestId('bell-popover')).toBeInTheDocument();
    // empty state from notifications.empty locale entry
    expect(screen.getByText(/No pending notifications/i)).toBeInTheDocument();
  });
});

describe('BellMenu — pending list render', () => {
  it('renders one row per pending request with role chip + approve/reject buttons', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.listPendingByProject).mockResolvedValueOnce({
      data: [fakePending(REQ1, 'edit'), fakePending(REQ2, 'view')],
    });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));

    expect(await screen.findByTestId(`bell-request-${REQ1}`)).toBeInTheDocument();
    expect(screen.getByTestId(`bell-request-${REQ2}`)).toBeInTheDocument();
    expect(screen.getByTestId(`bell-approve-${REQ1}`)).toBeInTheDocument();
    expect(screen.getByTestId(`bell-reject-${REQ1}`)).toBeInTheDocument();
  });
});

describe('BellMenu — approve / reject mutations', () => {
  it('clicking approve calls accessRequestsApi.decide with decision=approved + success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.listPendingByProject).mockResolvedValueOnce({
      data: [fakePending(REQ1, 'view')],
    });
    vi.mocked(accessRequestsApi.decide).mockResolvedValueOnce({
      data: fakePending(REQ1, 'view', null, 'approved'),
    });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-approve-${REQ1}`));

    await waitFor(() => {
      expect(accessRequestsApi.decide).toHaveBeenCalledWith(PID, REQ1, {
        decision: 'approved',
      });
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('clicking reject calls decide with decision=rejected + success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.listPendingByProject).mockResolvedValueOnce({
      data: [fakePending(REQ1, 'edit')],
    });
    vi.mocked(accessRequestsApi.decide).mockResolvedValueOnce({
      data: fakePending(REQ1, 'edit', null, 'rejected'),
    });
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-reject-${REQ1}`));

    await waitFor(() => {
      expect(accessRequestsApi.decide).toHaveBeenCalledWith(PID, REQ1, {
        decision: 'rejected',
      });
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('toasts error when decide rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.listPendingByProject).mockResolvedValueOnce({
      data: [fakePending(REQ1, 'view')],
    });
    vi.mocked(accessRequestsApi.decide).mockRejectedValueOnce(
      new ApiException({
        status: 409,
        code: 'CONFLICT',
        message: 'Already reviewed',
      }),
    );
    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-approve-${REQ1}`));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Already reviewed');
    });
  });

  it('approve + reject buttons are disabled only on the row whose mutation is in-flight', async () => {
    const user = userEvent.setup();
    vi.mocked(accessRequestsApi.listPendingByProject).mockResolvedValueOnce({
      data: [fakePending(REQ1, 'view'), fakePending(REQ2, 'edit')],
    });
    // never resolves — keeps the mutation in-flight long enough to
    // inspect the disabled state on the row we clicked.
    let resolve!: (v: { data: ReturnType<typeof fakePending> }) => void;
    vi.mocked(accessRequestsApi.decide).mockImplementationOnce(
      () => new Promise((r) => { resolve = r; }),
    );

    setup();
    await user.click(screen.getByTestId('bell-trigger'));
    await user.click(await screen.findByTestId(`bell-approve-${REQ1}`));

    // mid-flight: REQ1 buttons disabled, REQ2 buttons still enabled
    await waitFor(() => {
      expect(screen.getByTestId(`bell-approve-${REQ1}`)).toBeDisabled();
    });
    expect(screen.getByTestId(`bell-reject-${REQ1}`)).toBeDisabled();
    expect(screen.getByTestId(`bell-approve-${REQ2}`)).not.toBeDisabled();
    expect(screen.getByTestId(`bell-reject-${REQ2}`)).not.toBeDisabled();

    // unblock the pending mutation so test teardown isn't noisy
    resolve({ data: fakePending(REQ1, 'view', null, 'approved') });
  });
});
