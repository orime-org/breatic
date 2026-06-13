// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import RecoveryCodePage from '@web/pages/auth/RecoveryCodePage';

function renderAt(state: { code: string; next: string } | null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/recovery-code', state }]}>
      <Routes>
        <Route path='/recovery-code' element={<RecoveryCodePage />} />
        <Route path='/login' element={<div data-testid='login-page' />} />
        <Route
          path='/choose-slug'
          element={<div data-testid='onboarding-page' />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RecoveryCodePage', () => {
  it('shows the recovery code from navigation state', () => {
    renderAt({ code: 'AAAA-BBBB-CCCC-DDDD', next: '/choose-slug' });
    expect(screen.getByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument();
  });

  it('redirects to /login when reached without a code (direct nav / refresh)', () => {
    renderAt(null);
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });

  it('gates Continue behind the acknowledge checkbox, then navigates to next', async () => {
    const user = userEvent.setup();
    renderAt({ code: 'AAAA-BBBB-CCCC-DDDD', next: '/choose-slug' });

    const cont = screen.getByRole('button', { name: 'Continue' });
    expect(cont).toBeDisabled();

    await user.click(screen.getByLabelText(/I have saved this recovery code/i));
    expect(cont).toBeEnabled();

    await user.click(cont);
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-page')).toBeInTheDocument(),
    );
  });
});
