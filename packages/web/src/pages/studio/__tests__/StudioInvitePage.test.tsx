// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import StudioInvitePage from '@web/pages/studio/StudioInvitePage';
import { ApiException } from '@web/data/api/types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import type { InvitationLandingView } from '@breatic/shared';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    getInvitation: vi.fn(),
    respondInvitation: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { studiosApi } from '@web/data/api/studios';
import { toast } from 'sonner';

const TOKEN = 'tok-abc';

/** A landing view with sensible defaults; override per test. */
function makeView(o: Partial<InvitationLandingView> = {}): InvitationLandingView {
  return {
    studioName: 'Pixel Lab',
    studioSlug: 'pixel-lab',
    inviterName: 'Ana',
    role: 'member',
    expired: false,
    isInvitee: true,
    ...o,
  };
}

/**
 * Render the page at the invite URL, plus stub routes for the post-confirm
 * redirect (/studio/:slug) and the footer links (/login, /studio) so we can
 * assert "did it navigate".
 */
function setup(initial = `/studio-invite?token=${TOKEN}`) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path='/studio-invite' element={<StudioInvitePage />} />
        <Route path='/studio/:slug' element={<div>StudioStub</div>} />
        <Route path='/studio' element={<div>RecentStub</div>} />
        <Route path='/login' element={<div>LoginStub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StudioInvitePage', () => {
  it('shows the loading card while the invite is being fetched', () => {
    vi.mocked(studiosApi.getInvitation).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    setup();
    expect(screen.getByText(/Opening your invitation/i)).toBeInTheDocument();
  });

  it('renders the confirm card for the invitee with studio + inviter + role', async () => {
    vi.mocked(studiosApi.getInvitation).mockResolvedValueOnce(
      makeView({ role: 'creator' }),
    );
    setup();
    expect(
      await screen.findByText(/Ana invited you to join Pixel Lab as a creator/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Accept & join' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('confirm → respondInvitation(confirm), redirect to /studio/:slug + success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.getInvitation).mockResolvedValueOnce(makeView());
    vi.mocked(studiosApi.respondInvitation).mockResolvedValueOnce({
      studioSlug: 'pixel-lab',
    });
    setup();
    await user.click(await screen.findByRole('button', { name: 'Accept & join' }));

    await waitFor(() => {
      expect(studiosApi.respondInvitation).toHaveBeenCalledWith(TOKEN, 'confirm');
    });
    expect(await screen.findByText('StudioStub')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it('decline → respondInvitation(decline), shows the declined card (no redirect)', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.getInvitation).mockResolvedValueOnce(makeView());
    vi.mocked(studiosApi.respondInvitation).mockResolvedValueOnce({
      studioSlug: 'pixel-lab',
    });
    setup();
    await user.click(await screen.findByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(studiosApi.respondInvitation).toHaveBeenCalledWith(TOKEN, 'decline');
    });
    expect(await screen.findByText(/Invitation declined/i)).toBeInTheDocument();
    expect(screen.queryByText('StudioStub')).not.toBeInTheDocument();
  });

  it('shows the expired card (no action buttons) when the window has elapsed', async () => {
    vi.mocked(studiosApi.getInvitation).mockResolvedValueOnce(
      makeView({ expired: true }),
    );
    setup();
    expect(
      await screen.findByText(/This invitation has expired/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept & join' })).toBeNull();
  });

  it('shows the not-for-this-account card when the viewer is not the invitee', async () => {
    vi.mocked(studiosApi.getInvitation).mockResolvedValueOnce(
      makeView({ isInvitee: false }),
    );
    setup();
    expect(
      await screen.findByText(/isn't for this account/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept & join' })).toBeNull();
  });

  it('shows the invalid card when the token is gone (404)', async () => {
    vi.mocked(studiosApi.getInvitation).mockRejectedValueOnce(
      new ApiException({ status: 404, code: 'NOT_FOUND', message: 'gone' }),
    );
    setup();
    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument();
  });

  it('shows the invalid card and never calls the API when no token is present', () => {
    setup('/studio-invite');
    expect(screen.getByText(/no longer valid/i)).toBeInTheDocument();
    expect(studiosApi.getInvitation).not.toHaveBeenCalled();
  });

  it('toasts the server error and stays on the confirm card when respond rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.getInvitation).mockResolvedValueOnce(makeView());
    vi.mocked(studiosApi.respondInvitation).mockRejectedValueOnce(
      new ApiException({
        status: 404,
        code: 'NOT_FOUND',
        message: 'Already decided',
      }),
    );
    setup();
    await user.click(await screen.findByRole('button', { name: 'Accept & join' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Already decided');
    });
    expect(
      screen.getByRole('button', { name: 'Accept & join' }),
    ).toBeInTheDocument();
  });

  it('has no axe violations on the confirm card', async () => {
    vi.mocked(studiosApi.getInvitation).mockResolvedValueOnce(makeView());
    const { container } = setup();
    await screen.findByRole('button', { name: 'Accept & join' });
    await expectNoA11yViolations(container);
  });
});
