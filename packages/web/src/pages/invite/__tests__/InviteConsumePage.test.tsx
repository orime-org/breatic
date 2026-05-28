import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import InviteConsumePage from '@/pages/invite/InviteConsumePage';
import { ApiException } from '@/data/api/types';

const TOKEN = 'abc-token-xyz';
const PID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/data/api/invite-links', () => ({
  inviteLinksApi: {
    consume: vi.fn(),
  },
}));

import { inviteLinksApi } from '@/data/api/invite-links';

/**
 * Renders the page inside a memory router pointed at /invite/:token,
 * plus stub catchers for every route the page might navigate to so
 * we can assert "did the navigate happen" by reading the rendered
 * stub.
 */
function setup() {
  return render(
    <MemoryRouter initialEntries={[`/invite/${TOKEN}`]}>
      <Routes>
        <Route path='/invite/:token' element={<InviteConsumePage />} />
        <Route path='/project/:projectId' element={<div>ProjectStub</div>} />
        <Route path='/studio' element={<div>StudioStub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InviteConsumePage', () => {
  it('shows the loading card while consume is in flight', () => {
    // never resolves — keeps the page in the loading state
    vi.mocked(inviteLinksApi.consume).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    setup();
    // i18n key for loading title is rendered (fallback to the key
    // string since locale entry not added yet)
    expect(screen.getByText(/invite\.consume\.loadingTitle/)).toBeInTheDocument();
  });

  it('navigates to /project/:projectId on successful consume', async () => {
    vi.mocked(inviteLinksApi.consume).mockResolvedValueOnce({
      data: makeFakeLink({ projectId: PID }),
    });
    setup();
    expect(await screen.findByText('ProjectStub')).toBeInTheDocument();
    expect(inviteLinksApi.consume).toHaveBeenCalledWith(TOKEN);
  });

  it('navigates to /studio when consume returns 403 (expired or already consumed)', async () => {
    vi.mocked(inviteLinksApi.consume).mockRejectedValueOnce(
      new ApiException({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Link expired',
      }),
    );
    setup();
    expect(await screen.findByText('StudioStub')).toBeInTheDocument();
  });

  it('navigates to /studio when consume returns 404 (revoked or unknown token)', async () => {
    vi.mocked(inviteLinksApi.consume).mockRejectedValueOnce(
      new ApiException({
        status: 404,
        code: 'NOT_FOUND',
        message: 'Link not found',
      }),
    );
    setup();
    expect(await screen.findByText('StudioStub')).toBeInTheDocument();
  });

  it('shows the error card (no navigate) when consume fails with non-403/404 ApiException', async () => {
    vi.mocked(inviteLinksApi.consume).mockRejectedValueOnce(
      new ApiException({
        status: 500,
        code: 'INTERNAL',
        message: 'Server exploded',
      }),
    );
    setup();
    await waitFor(() => {
      expect(screen.getByText(/Server exploded/)).toBeInTheDocument();
    });
    expect(screen.queryByText('ProjectStub')).not.toBeInTheDocument();
    expect(screen.queryByText('StudioStub')).not.toBeInTheDocument();
  });

  it('shows the generic-failure card when consume throws a non-ApiException error', async () => {
    vi.mocked(inviteLinksApi.consume).mockRejectedValueOnce(
      new Error('network down'),
    );
    setup();
    // Generic-failure i18n key fallback to the key string (real raw
    // Error.message is intentionally NOT leaked to UI for safety —
    // network/stack noise belongs in console only)
    expect(
      await screen.findByText(/invite\.consume\.failed/),
    ).toBeInTheDocument();
  });
});

// ── helpers ────────────────────────────────────────────────────────

interface FakeLinkOverrides {
  projectId?: string;
  token?: string;
}

function makeFakeLink(o: FakeLinkOverrides = {}) {
  return {
    id: 'sl-1',
    projectId: o.projectId ?? PID,
    createdByUserId: 'u-owner',
    token: o.token ?? TOKEN,
    role: 'view',
    isPermanent: false,
    consumedAt: new Date().toISOString(),
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
}
