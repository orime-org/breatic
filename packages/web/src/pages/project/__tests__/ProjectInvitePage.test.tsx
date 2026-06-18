// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import ProjectInvitePage from '@web/pages/project/ProjectInvitePage';
import { ApiException } from '@web/data/api/types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import type { ProjectInvitationLandingView } from '@breatic/shared';

vi.mock('@web/data/api/project-invitations', () => ({
  projectInvitationsApi: {
    getInvitation: vi.fn(),
    respondInvitation: vi.fn(),
    inviteMember: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { projectInvitationsApi } from '@web/data/api/project-invitations';
import { toast } from 'sonner';

const TOKEN = 'tok-abc';
const PID = '11111111-1111-4111-8111-111111111111';

/** A landing view with sensible defaults; override per test. */
function makeView(
  o: Partial<ProjectInvitationLandingView> = {},
): ProjectInvitationLandingView {
  return {
    projectName: 'Q1 Sprint',
    projectSlug: 'q1-sprint',
    projectId: PID,
    inviterName: 'Ana',
    role: 'editor',
    expired: false,
    isInvitee: true,
    ...o,
  };
}

/**
 * Render the page at the invite URL, plus stub routes for the post-confirm
 * redirect (/project/:projectId) and the footer links (/login, /studio) so we
 * can assert "did it navigate".
 * @param initial - The initial entry URL to render at.
 * @returns the rendered page.
 */
function setup(initial = `/project-invite?token=${TOKEN}`): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path='/project-invite' element={<ProjectInvitePage />} />
        <Route path='/project/:projectId' element={<div>ProjectStub</div>} />
        <Route path='/studio' element={<div>RecentStub</div>} />
        <Route path='/login' element={<div>LoginStub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProjectInvitePage', () => {
  it('shows the loading card while the invite is being fetched', () => {
    vi.mocked(projectInvitationsApi.getInvitation).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    setup();
    expect(screen.getByText(/Opening your invitation/i)).toBeInTheDocument();
  });

  it('renders the confirm card for the invitee with project + inviter + role', async () => {
    vi.mocked(projectInvitationsApi.getInvitation).mockResolvedValueOnce(
      makeView({ role: 'editor' }),
    );
    setup();
    expect(
      await screen.findByText(/Ana invited you to join Q1 Sprint as an editor/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Accept & join' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('confirm → respondInvitation(confirm), redirect to /project/:projectId + success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(projectInvitationsApi.getInvitation).mockResolvedValueOnce(
      makeView(),
    );
    vi.mocked(projectInvitationsApi.respondInvitation).mockResolvedValueOnce({
      projectId: PID,
      projectSlug: 'q1-sprint',
    });
    setup();
    await user.click(
      await screen.findByRole('button', { name: 'Accept & join' }),
    );

    await waitFor(() => {
      expect(projectInvitationsApi.respondInvitation).toHaveBeenCalledWith(
        TOKEN,
        'confirm',
      );
    });
    expect(await screen.findByText('ProjectStub')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it('decline → respondInvitation(decline), shows the declined card (no redirect)', async () => {
    const user = userEvent.setup();
    vi.mocked(projectInvitationsApi.getInvitation).mockResolvedValueOnce(
      makeView(),
    );
    vi.mocked(projectInvitationsApi.respondInvitation).mockResolvedValueOnce({
      projectId: PID,
      projectSlug: 'q1-sprint',
    });
    setup();
    await user.click(await screen.findByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(projectInvitationsApi.respondInvitation).toHaveBeenCalledWith(
        TOKEN,
        'decline',
      );
    });
    expect(
      await screen.findByText(/Invitation declined/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('ProjectStub')).not.toBeInTheDocument();
  });

  it('shows the expired card (no action buttons) when the window has elapsed', async () => {
    vi.mocked(projectInvitationsApi.getInvitation).mockResolvedValueOnce(
      makeView({ expired: true }),
    );
    setup();
    expect(
      await screen.findByText(/This invitation has expired/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Accept & join' }),
    ).toBeNull();
  });

  it('shows the not-for-this-account card when the viewer is not the invitee', async () => {
    vi.mocked(projectInvitationsApi.getInvitation).mockResolvedValueOnce(
      makeView({ isInvitee: false }),
    );
    setup();
    expect(
      await screen.findByText(/isn't for this account/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Accept & join' }),
    ).toBeNull();
  });

  it('shows the invalid card when the token is gone (404)', async () => {
    vi.mocked(projectInvitationsApi.getInvitation).mockRejectedValueOnce(
      new ApiException({ status: 404, code: 'NOT_FOUND', message: 'gone' }),
    );
    setup();
    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument();
  });

  it('shows the invalid card and never calls the API when no token is present', () => {
    setup('/project-invite');
    expect(screen.getByText(/no longer valid/i)).toBeInTheDocument();
    expect(projectInvitationsApi.getInvitation).not.toHaveBeenCalled();
  });

  it('toasts the server error and stays on the confirm card when respond rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(projectInvitationsApi.getInvitation).mockResolvedValueOnce(
      makeView(),
    );
    vi.mocked(projectInvitationsApi.respondInvitation).mockRejectedValueOnce(
      new ApiException({
        status: 404,
        code: 'NOT_FOUND',
        message: 'Already decided',
      }),
    );
    setup();
    await user.click(
      await screen.findByRole('button', { name: 'Accept & join' }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Already decided');
    });
    expect(
      screen.getByRole('button', { name: 'Accept & join' }),
    ).toBeInTheDocument();
  });

  it('has no axe violations on the confirm card', async () => {
    vi.mocked(projectInvitationsApi.getInvitation).mockResolvedValueOnce(
      makeView(),
    );
    const { container } = setup();
    await screen.findByRole('button', { name: 'Accept & join' });
    await expectNoA11yViolations(container);
  });
});
