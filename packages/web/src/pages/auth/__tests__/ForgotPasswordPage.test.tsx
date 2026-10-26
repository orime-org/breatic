// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import ForgotPasswordPage from '@web/pages/auth/ForgotPasswordPage';
import { authApi } from '@web/data/api/auth';

vi.mock('@web/data/api/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@web/data/api/auth')>('@web/data/api/auth');
  return { ...actual, authApi: { options: vi.fn(), forgotPassword: vi.fn() } };
});

function setup() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage offers only the way that works here', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers the reset email and nothing else when email is enabled (A8)', async () => {
    vi.mocked(authApi.options).mockResolvedValueOnce({ emailVerification: true });
    setup();
    expect(await screen.findByRole('button', { name: 'Email me a reset link' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recovery code/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/recovery code/i)).not.toBeInTheDocument();
  });

  it('offers the recovery code and nothing else when email is disabled (A10)', async () => {
    vi.mocked(authApi.options).mockResolvedValueOnce({ emailVerification: false });
    setup();
    expect(await screen.findByRole('button', { name: /recovery code/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email me a reset link' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('shows neither way while it is still asking the server', () => {
    vi.mocked(authApi.options).mockReturnValueOnce(new Promise(() => {}));
    setup();
    expect(screen.queryByRole('button', { name: 'Email me a reset link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recovery code/i })).not.toBeInTheDocument();
  });

  it('marks the send button busy while the reset link is being sent, then shows the sent card', async () => {
    vi.mocked(authApi.options).mockResolvedValueOnce({ emailVerification: true });
    let answer!: (value: { message: string }) => void;
    vi.mocked(authApi.forgotPassword).mockReturnValueOnce(
      new Promise((resolve) => { answer = resolve; }),
    );
    const user = userEvent.setup();
    setup();
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }));

    const busy = screen.getByRole('button', { name: 'Sending...' });
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

    answer({ message: 'sent' });
    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { busy: true })).toBeNull();
  });

  it('clears the busy mark on the send button after a failed send', async () => {
    vi.mocked(authApi.options).mockResolvedValueOnce({ emailVerification: true });
    let fail!: (reason: unknown) => void;
    vi.mocked(authApi.forgotPassword).mockReturnValueOnce(
      new Promise((_, reject) => { fail = reject; }),
    );
    const user = userEvent.setup();
    setup();
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }));
    expect(screen.getByRole('button', { name: 'Sending...' })).toHaveAttribute('aria-busy', 'true');

    fail(new Error('network'));
    const idle = await screen.findByRole('button', { name: 'Email me a reset link' });
    expect(idle).not.toHaveAttribute('aria-busy');
    expect(idle).not.toHaveAttribute('aria-disabled');
  });

  it('says it could not load when the server does not answer', async () => {
    vi.mocked(authApi.options).mockRejectedValueOnce(new Error('network'));
    setup();
    expect(await screen.findByText('This page could not load. Refresh to try again.')).toBeInTheDocument();
  });
});
