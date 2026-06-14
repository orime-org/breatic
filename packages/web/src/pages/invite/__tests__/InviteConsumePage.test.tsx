// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import InviteConsumePage from '@web/pages/invite/InviteConsumePage';
import { ApiException } from '@web/data/api/types';

const TOKEN = 'abc-token-xyz';
const PID = '11111111-1111-4111-8111-111111111111';

vi.mock('@web/data/api/invite-links', () => ({
  inviteLinksApi: {
    consume: vi.fn(),
  },
}));

import { inviteLinksApi, type InviteLink } from '@web/data/api/invite-links';

/**
 * Renders the page inside a memory router pointed at /invite/:token,
 * plus a project stub so we can assert "did the navigate happen" on
 * the success path. Per 2026-05-28 spec § 2.1, expired / revoked /
 * already-consumed links no longer bounce to /studio — they show an
 * in-page friendly error so the user knows what to do next.
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
    vi.mocked(inviteLinksApi.consume).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    setup();
    // Loading copy now resolves via locale file (Joining project…),
    // not the raw key.
    expect(
      screen.getByText(/Joining project/i),
    ).toBeInTheDocument();
  });

  it('navigates to /project/:projectId on successful consume', async () => {
    vi.mocked(inviteLinksApi.consume).mockResolvedValueOnce(makeFakeLink({ projectId: PID }));
    setup();
    expect(await screen.findByText('ProjectStub')).toBeInTheDocument();
    expect(inviteLinksApi.consume).toHaveBeenCalledWith(TOKEN);
  });

  it('shows the expired/invalid card when consume returns 403', async () => {
    vi.mocked(inviteLinksApi.consume).mockRejectedValueOnce(
      new ApiException({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Link expired',
      }),
    );
    setup();
    await waitFor(() => {
      expect(
        screen.getByText(/no longer valid/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('ProjectStub')).not.toBeInTheDocument();
    expect(screen.queryByText('StudioStub')).not.toBeInTheDocument();
  });

  it('shows the expired/invalid card when consume returns 404', async () => {
    vi.mocked(inviteLinksApi.consume).mockRejectedValueOnce(
      new ApiException({
        status: 404,
        code: 'NOT_FOUND',
        message: 'Link not found',
      }),
    );
    setup();
    await waitFor(() => {
      expect(
        screen.getByText(/no longer valid/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('ProjectStub')).not.toBeInTheDocument();
  });

  it('shows the expired/invalid card when consume returns 410 Gone (consumed)', async () => {
    vi.mocked(inviteLinksApi.consume).mockRejectedValueOnce(
      new ApiException({
        status: 410,
        code: 'GONE',
        message: 'Already consumed',
      }),
    );
    setup();
    await waitFor(() => {
      expect(
        screen.getByText(/no longer valid/i),
      ).toBeInTheDocument();
    });
  });

  it('shows the raw server message when consume fails with non-link-invalid ApiException', async () => {
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
  });

  it('shows the generic-failure copy when consume throws a non-ApiException error', async () => {
    vi.mocked(inviteLinksApi.consume).mockRejectedValueOnce(
      new Error('network down'),
    );
    setup();
    await waitFor(() => {
      expect(
        screen.getByText(/Something went wrong accepting this invite/i),
      ).toBeInTheDocument();
    });
  });
});

// ── helpers ────────────────────────────────────────────────────────

interface FakeLinkOverrides {
  projectId?: string;
  token?: string;
}

function makeFakeLink(o: FakeLinkOverrides = {}): InviteLink {
  return {
    id: 'sl-1',
    projectId: o.projectId ?? PID,
    createdByUserId: 'u-owner',
    token: o.token ?? TOKEN,
    role: 'viewer',
    kind: 'link',
    boundEmail: null,
    consumedAt: new Date().toISOString(),
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
}
