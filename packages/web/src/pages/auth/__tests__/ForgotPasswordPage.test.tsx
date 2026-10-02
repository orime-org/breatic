// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('says it could not load when the server does not answer', async () => {
    vi.mocked(authApi.options).mockRejectedValueOnce(new Error('network'));
    setup();
    expect(await screen.findByText('This page could not load. Refresh to try again.')).toBeInTheDocument();
  });
});
