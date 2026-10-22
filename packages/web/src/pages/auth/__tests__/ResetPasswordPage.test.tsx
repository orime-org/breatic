// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import ResetPasswordPage from '@web/pages/auth/ResetPasswordPage';
import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';

vi.mock('@web/data/api/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@web/data/api/auth')>('@web/data/api/auth');
  return {
    ...actual,
    authApi: { resetPasswordWithToken: vi.fn(), resetPasswordWithRecoveryCode: vi.fn() },
  };
});

/**
 * Render the reset page at the given entry, with the two places it can leave for.
 * @param entry - The URL the reader arrived at.
 * @returns The render result.
 */
function setup(entry: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path='/reset-password' element={<ResetPasswordPage />} />
        <Route path='/login' element={<div data-testid='login-page' />} />
        <Route path='/recovery-code' element={<div data-testid='recovery-code-page' />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Fill the recovery-code form and submit it.
 * @param user - The user-event instance driving the page.
 */
async function submitRecovery(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Email'), 'ada@example.com');
  await user.type(screen.getByLabelText('Recovery code'), 'AAAA-BBBB-CCCC-DDDD');
  await user.type(screen.getByLabelText('New password'), 'supersecret');
  await user.click(screen.getByRole('button', { name: 'Save password' }));
}

/**
 * Fill the token form and submit it.
 * @param user - The user-event instance driving the page.
 */
async function submitToken(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('New password'), 'supersecret');
  await user.click(screen.getByRole('button', { name: 'Save password' }));
}

beforeEach(() => vi.clearAllMocks());

describe('ResetPasswordPage with a reset link', () => {
  it('marks the save button busy while the password is being saved, then leaves for sign-in', async () => {
    let answer!: (value: { message: string }) => void;
    vi.mocked(authApi.resetPasswordWithToken).mockReturnValueOnce(
      new Promise((resolve) => { answer = resolve; }),
    );
    const user = userEvent.setup();
    setup('/reset-password?token=t-1');
    await submitToken(user);

    const busy = screen.getByRole('button', { name: 'Saving...' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    // Read-only keeps the focus Enter left in a field, so a refused submit is
    // corrected by typing straight away (inner#1652).
    const held = document.querySelectorAll('form input');
    expect(held.length).toBeGreaterThan(0);
    for (const field of held) {
      expect(field).toHaveAttribute('readonly');
      expect(field).not.toBeDisabled();
    }
    expect(busy).toHaveAttribute('aria-disabled', 'true');

    answer({ message: 'ok' });
    expect(await screen.findByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { busy: true })).toBeNull();
  });

  it('clears the busy mark on the save button after a refused reset', async () => {
    let fail!: (reason: unknown) => void;
    vi.mocked(authApi.resetPasswordWithToken).mockReturnValueOnce(
      new Promise((_, reject) => { fail = reject; }),
    );
    const user = userEvent.setup();
    setup('/reset-password?token=t-1');
    await submitToken(user);
    expect(screen.getByRole('button', { name: 'Saving...' })).toHaveAttribute('aria-busy', 'true');

    fail(new ApiException({ status: 400, message: 'This link has expired.' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired.');
    const idle = screen.getByRole('button', { name: 'Save password' });
    expect(idle).not.toHaveAttribute('aria-busy');
    expect(idle).not.toHaveAttribute('aria-disabled');
  });
});

describe('ResetPasswordPage with a recovery code', () => {
  it('marks the save button busy while the password is being saved, then shows the new code', async () => {
    let answer!: (value: Awaited<ReturnType<typeof authApi.resetPasswordWithRecoveryCode>>) => void;
    vi.mocked(authApi.resetPasswordWithRecoveryCode).mockReturnValueOnce(
      new Promise((resolve) => { answer = resolve; }),
    );
    const user = userEvent.setup();
    setup('/reset-password?mode=recovery');
    await submitRecovery(user);

    const busy = screen.getByRole('button', { name: 'Saving...' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    // Read-only keeps the focus Enter left in a field, so a refused submit is
    // corrected by typing straight away (inner#1652).
    const held = document.querySelectorAll('form input');
    expect(held.length).toBeGreaterThan(0);
    for (const field of held) {
      expect(field).toHaveAttribute('readonly');
      expect(field).not.toBeDisabled();
    }
    expect(busy).toHaveAttribute('aria-disabled', 'true');

    answer({ newRecoveryCode: 'EEEE-FFFF-GGGG-HHHH' });
    expect(await screen.findByTestId('recovery-code-page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { busy: true })).toBeNull();
  });

  it('clears the busy mark on the save button after a refused reset', async () => {
    let fail!: (reason: unknown) => void;
    vi.mocked(authApi.resetPasswordWithRecoveryCode).mockReturnValueOnce(
      new Promise((_, reject) => { fail = reject; }),
    );
    const user = userEvent.setup();
    setup('/reset-password?mode=recovery');
    await submitRecovery(user);
    expect(screen.getByRole('button', { name: 'Saving...' })).toHaveAttribute('aria-busy', 'true');

    fail(new ApiException({ status: 400, message: 'That recovery code is wrong.' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That recovery code is wrong.');
    const idle = screen.getByRole('button', { name: 'Save password' });
    expect(idle).not.toHaveAttribute('aria-busy');
    expect(idle).not.toHaveAttribute('aria-disabled');
  });
});
