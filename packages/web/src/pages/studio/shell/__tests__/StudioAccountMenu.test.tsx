// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { authApi } from '@web/data/api/auth';
import { StudioAccountMenu } from '@web/pages/studio/shell/StudioAccountMenu';
import { useCurrentUserStore } from '@web/stores/current-user';

vi.mock('@web/data/api/auth', () => ({
  authApi: { logout: vi.fn() },
}));

const ALEX = {
  id: 'u1',
  name: 'Alex',
  email: 'alex@x.example',
  personalStudio: null,
};

describe('StudioAccountMenu', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
    vi.mocked(authApi.logout).mockReset().mockResolvedValue(undefined);
  });

  it('shows the current user initial on the avatar button', () => {
    useCurrentUserStore.getState().setUser(ALEX);
    render(<StudioAccountMenu />);
    expect(screen.getByRole('button', { name: 'Account' })).toHaveTextContent(
      'A',
    );
  });

  it('opens the popover and signs out — calls the logout API then clears the user', async () => {
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    render(<StudioAccountMenu />);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(authApi.logout).toHaveBeenCalledTimes(1);
    // Clearing the local user is what drives ProtectedRoute to /login.
    await waitFor(() =>
      expect(useCurrentUserStore.getState().user).toBeNull(),
    );
  });
});
