// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from '@web/data/api/auth';
import type * as MockModule1 from '@web/pages/studio/container/dialogs/use-slug-availability';

import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { t } from '@breatic/shared';

import RegisterPage from '@web/pages/auth/RegisterPage';
import LoginPage from '@web/pages/auth/LoginPage';
import SlugSetupPage from '@web/pages/auth/SlugSetupPage';
import RecoveryCodePage from '@web/pages/auth/RecoveryCodePage';
import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';

const preview = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof MockModule0>();
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      invitation: preview,
      register: vi.fn(),
      verifySignupCode: vi.fn(),
      resendSignupCode: vi.fn(),
      login: vi.fn(),
      setupStudio: vi.fn(),
    },
  };
});
vi.mock('@web/pages/studio/container/dialogs/use-slug-availability', async (importOriginal) => ({
  ...await importOriginal<typeof MockModule1>(),
  useSlugAvailability: vi.fn(),
}));

const TOKEN = 'invitation-token';
const DESTINATION = `/decision?token=${TOKEN}`;
const INVITED_EMAIL = 'recipient@example.test';
const USER = { id: 'invitee', email: INVITED_EMAIL, personalStudio: null, membershipTier: 'base', locale: 'en' } as const;
const OPEN = { state: 'open', email: INVITED_EMAIL, inviterName: 'Ada', kind: 'project', targetName: 'Film', role: 'viewer' } as const;
const CODE_SENT = { status: 'code_sent', expiresInSeconds: 600, resendAfterSeconds: 0 } as const;

/** Exposes the destination reached through real router navigation. */
function LocationProbe(): ReactElement {
  const location = useLocation();
  return <output data-testid='invitation-location'>{location.pathname}{location.search}</output>;
}

/** Renders the real auth pages with their invitation landing route. */
function setup(entry: string): ReturnType<typeof render> & { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <Routes>
          <Route path='/register' element={<RegisterPage />} />
          <Route path='/login' element={<LoginPage />} />
          <Route path='/choose-slug' element={<SlugSetupPage />} />
          <Route path='/recovery-code' element={<RecoveryCodePage />} />
          <Route path='/decision' element={<div data-testid='invitation-decision' />} />
          <Route path='/studio' element={<div data-testid='invitation-studio' />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/**
 * Submit the invitation's prefilled address through the real registration form.
 * @returns The active query cache and the user driving the verification step.
 * @throws {Error} When registration cannot reach the verification step.
 */
async function startInvitedSignup(): Promise<{ client: QueryClient; user: ReturnType<typeof userEvent.setup> }> {
  vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
  const user = userEvent.setup();
  const { client } = setup(`/register?invite=${TOKEN}`);
  await waitFor(() => expect(screen.getByLabelText('Email')).toHaveValue(INVITED_EMAIL));
  await user.type(screen.getByLabelText('Password'), 'password-123');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  expect(await screen.findByLabelText('Verification code')).toBeInTheDocument();
  expect(authApi.register).toHaveBeenCalledWith({ email: INVITED_EMAIL, password: 'password-123' });
  return { client, user };
}

/**
 * Apply a closed preview and flush React Query's scheduled observer notifications.
 * @param client - The query cache observed by the mounted registration page.
 * @returns Once the closed preview has reached the page's observers.
 */
async function closeInvitationPreview(client: QueryClient): Promise<void> {
  await act(async () => {
    client.setQueryData(['auth', 'invitation', TOKEN], { state: 'closed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue(OPEN);
  vi.mocked(useSlugAvailability).mockReturnValue({ state: 'valid' });
  useCurrentUserStore.setState({ user: null, role: null, loading: false, bootstrapped: true });
});

describe('invitation registration preview', () => {
  it('prefills the invited email and shows the inviter and target', async () => {
    setup(`/register?invite=${TOKEN}`);
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveValue(INVITED_EMAIL));
    expect(preview).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByText(t('auth.register.invitedBanner', { inviterName: 'Ada', targetName: 'Film' }))).toBeInTheDocument();
  });

  it('allows another email and explains which address owns the invitation', async () => {
    const user = userEvent.setup();
    setup(`/register?invite=${TOKEN}`);
    const email = screen.getByLabelText('Email');
    await waitFor(() => expect(email).toHaveValue(INVITED_EMAIL));
    await user.clear(email);
    await user.type(email, 'other@example.test');
    expect(screen.getByText(t('auth.register.invitedEmailMismatch', { email: INVITED_EMAIL }))).toBeInTheDocument();
    await user.clear(email);
    await user.type(email, INVITED_EMAIL);
    expect(screen.queryByText(t('auth.register.invitedEmailMismatch', { email: INVITED_EMAIL }))).toBeNull();
  });

  it('routes an already claimed token to its decision', async () => {
    preview.mockResolvedValueOnce({ state: 'claimed' });
    setup(`/register?invite=${TOKEN}`);
    expect(await screen.findByTestId('invitation-decision')).toBeInTheDocument();
    expect(screen.getByTestId('invitation-location')).toHaveTextContent(DESTINATION);
  });

  it.each(['closed', 'missing'] as const)('keeps registration usable and explains a %s invitation', async (state) => {
    if (state === 'closed') preview.mockResolvedValueOnce({ state: 'closed' });
    else preview.mockRejectedValueOnce(new ApiException({ status: 404, message: 'Invitation not found.' }));
    setup(`/register?invite=${TOKEN}`);
    expect(await screen.findByText(t('auth.register.inviteClosed'))).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('keeps the decision destination on the login link', async () => {
    setup(`/register?invite=${TOKEN}`);
    const link = screen.getByRole('link', { name: 'Sign in' });
    await waitFor(() => expect(link).toHaveAttribute('href', `/login?next=${encodeURIComponent(DESTINATION)}`));
  });

  it('preserves the decision after code verification and Slug setup', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce({ status: 'code_sent', expiresInSeconds: 600, resendAfterSeconds: 60 });
    vi.mocked(authApi.verifySignupCode).mockResolvedValueOnce({ user: USER });
    vi.mocked(authApi.setupStudio).mockResolvedValueOnce({ personalStudio: { name: 'new-recipient', slug: 'new-recipient', avatarUrl: null } });
    const user = userEvent.setup();
    setup(`/register?invite=${TOKEN}`);
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveValue(INVITED_EMAIL));
    await user.type(screen.getByLabelText('Password'), 'password-123');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await user.type(await screen.findByLabelText('Verification code'), '123456');
    await waitFor(() => expect(screen.getByTestId('invitation-location')).toHaveTextContent(`/choose-slug?next=${encodeURIComponent(DESTINATION)}`));
    await user.type(screen.getByLabelText('Slug'), 'new-recipient');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('invitation-decision')).toBeInTheDocument();
    expect(screen.getByTestId('invitation-location')).toHaveTextContent(DESTINATION);
  });

  it('keeps a generic decision next through verification when registration has no invite query', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce({ status: 'code_sent', expiresInSeconds: 600, resendAfterSeconds: 60 });
    vi.mocked(authApi.verifySignupCode).mockResolvedValueOnce({ user: USER });
    const user = userEvent.setup();
    setup(`/register?next=${encodeURIComponent(DESTINATION)}`);
    await user.type(screen.getByLabelText('Email'), INVITED_EMAIL);
    await user.type(screen.getByLabelText('Password'), 'password-123');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await user.type(await screen.findByLabelText('Verification code'), '123456');
    await waitFor(() => expect(screen.getByTestId('invitation-location')).toHaveTextContent(`/choose-slug?next=${encodeURIComponent(DESTINATION)}`));
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps a generic next value when login links to registration', () => {
    setup(`/login?next=${encodeURIComponent(DESTINATION)}`);
    expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', `/register?next=${encodeURIComponent(DESTINATION)}`);
  });

  it('keeps the decision destination when an already registered invitee signs in', async () => {
    vi.mocked(authApi.login).mockResolvedValueOnce({ user: { ...USER, personalStudio: { name: 'Recipient', slug: 'recipient', avatarUrl: null } } });
    const user = userEvent.setup();
    setup(`/login?next=${encodeURIComponent(DESTINATION)}`);
    await user.type(screen.getByLabelText('Email'), INVITED_EMAIL);
    await user.type(screen.getByLabelText('Password'), 'password-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('invitation-decision')).toBeInTheDocument();
    expect(screen.getByTestId('invitation-location')).toHaveTextContent(DESTINATION);
  });
});

describe('submitted invitation registration email', () => {
  it('keeps the submitted address in the verification prompt when the invitation preview closes', async () => {
    const { client } = await startInvitedSignup();
    expect(screen.getByText(INVITED_EMAIL, { exact: true })).toBeInTheDocument();

    await closeInvitationPreview(client);

    expect(screen.getByRole('heading', { name: t('auth.register.code.title') })).toBeInTheDocument();
    expect(screen.getByText(INVITED_EMAIL, { exact: true })).toBeInTheDocument();
  });

  it('keeps the submitted address when returning to the form after the invitation preview closes', async () => {
    const { client, user } = await startInvitedSignup();
    await closeInvitationPreview(client);

    await user.click(screen.getByRole('button', { name: t('auth.register.code.changeEmail') }));

    expect(screen.getByLabelText('Email')).toHaveValue(INVITED_EMAIL);
    expect(screen.getByLabelText('Password')).toHaveValue('password-123');
    expect(screen.getByText(t('auth.register.inviteClosed'))).toBeInTheDocument();
  });

  it.each(['verify', 'resend'] as const)('restarts an expired signup with the submitted address after %s and preserves its invitation destination', async (operation) => {
    const { client, user } = await startInvitedSignup();
    await closeInvitationPreview(client);
    vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
    const expired = new ApiException({ status: 410, message: 'The sign-up has expired.' });
    if (operation === 'verify') {
      vi.mocked(authApi.verifySignupCode).mockRejectedValueOnce(expired);
      await user.type(screen.getByLabelText('Verification code'), '123456');
    } else {
      vi.mocked(authApi.resendSignupCode).mockRejectedValueOnce(expired);
      await user.click(screen.getByRole('button', { name: t('auth.register.code.resend') }));
    }

    await waitFor(() => expect(authApi.register).toHaveBeenCalledTimes(2));
    expect(authApi.register).toHaveBeenLastCalledWith({ email: INVITED_EMAIL, password: 'password-123' });
    expect(await screen.findByText(t('auth.register.code.newCodeSent'))).toBeInTheDocument();

    vi.mocked(authApi.verifySignupCode).mockResolvedValueOnce({ user: USER });
    await user.type(screen.getByLabelText('Verification code'), '654321');
    await waitFor(() => expect(screen.getByTestId('invitation-location')).toHaveTextContent(`/choose-slug?next=${encodeURIComponent(DESTINATION)}`));
  });
});

describe('Slug setup next destination', () => {
  it.each([DESTINATION, '//outside.example/path', 'https://outside.example/path', 'relative'])('finishes at the safe destination for %s', async (next) => {
    useCurrentUserStore.setState({ user: { ...USER, name: 'Recipient' } });
    vi.mocked(authApi.setupStudio).mockResolvedValueOnce({ personalStudio: { name: 'new-recipient', slug: 'new-recipient', avatarUrl: null } });
    const user = userEvent.setup();
    setup(`/choose-slug?next=${encodeURIComponent(next)}`);
    await user.type(screen.getByLabelText('Slug'), 'new-recipient');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const marker = next === DESTINATION ? 'invitation-decision' : 'invitation-studio';
    expect(await screen.findByTestId(marker)).toBeInTheDocument();
    expect(screen.getByTestId('invitation-location')).toHaveTextContent(next === DESTINATION ? DESTINATION : '/studio');
  });
});


describe('email login next destination', () => {
  it.each(['//outside.example/path', 'https://outside.example/path', 'relative'])('falls back to Studio for %s', async (next) => {
    vi.mocked(authApi.login).mockResolvedValueOnce({ user: USER });
    const user = userEvent.setup();
    setup(`/login?next=${encodeURIComponent(next)}`);
    await user.type(screen.getByLabelText('Email'), INVITED_EMAIL);
    await user.type(screen.getByLabelText('Password'), 'password-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('invitation-studio')).toBeInTheDocument();
    expect(screen.getByTestId('invitation-location')).toHaveTextContent('/studio');
  });
});
