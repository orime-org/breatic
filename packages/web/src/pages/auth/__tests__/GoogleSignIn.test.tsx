// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from '../LoginPage';
import type * as AuthModule from '@web/data/api/auth';
import { authApi } from '@web/data/api/auth';
import { useCurrentUserStore } from '@web/stores/current-user';

const sdk = vi.hoisted(() => ({ initialize: vi.fn(), renderButton: vi.fn() }));
vi.mock('@web/data/api/auth', async (original) => ({
  ...await original<typeof AuthModule>(),
  authApi: { google: vi.fn(), login: vi.fn() },
}));

function setup() {
  const view = render(<MemoryRouter><LoginPage /></MemoryRouter>);
  const script = document.querySelector('script[src^="https://accounts.google.com/gsi/client"]');
  expect(script).not.toBeNull();
  act(() => { script?.dispatchEvent(new Event('load')); });
  return view;
}

function respond(credential: string | undefined = 'signed-google-id-token') {
  const config = sdk.initialize.mock.calls.at(-1)?.[0];
  expect(config.client_id).toBe('test.apps.googleusercontent.com');
  act(() => config.callback({ credential }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__GOOGLE_CLIENT_ID__', 'test.apps.googleusercontent.com');
  vi.stubGlobal('google', { accounts: { id: sdk } });
  useCurrentUserStore.setState({ user: null, loading: false, bootstrapped: true });
  document.documentElement.dataset.theme = 'light';
});

describe('official Google login', () => {
  it('uses outline_dark in light mode and outline in dark mode', async () => {
    setup();
    expect(sdk.renderButton).toHaveBeenLastCalledWith(expect.any(HTMLElement), expect.objectContaining({
      theme: 'outline_dark', size: 'large', shape: 'rectangular', text: 'continue_with', logo_alignment: 'left',
    }));
    act(() => { document.documentElement.dataset.theme = 'dark'; });
    await waitFor(() => expect(sdk.renderButton.mock.calls.at(-1)?.[1].theme).toBe('outline'));
    act(() => { document.documentElement.dataset.theme = 'light'; });
    await waitFor(() => expect(sdk.renderButton.mock.calls.at(-1)?.[1].theme).toBe('outline_dark'));
  });

  it('sends credential once and stores the returned user', async () => {
    let finish!: (value: Awaited<ReturnType<typeof authApi.google>>) => void;
    vi.mocked(authApi.google).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    setup();
    respond();
    respond();
    expect(authApi.google).toHaveBeenCalledExactlyOnceWith({ credential: 'signed-google-id-token' });
    expect(screen.getByRole('button', { name: 'Signing in...' })).toBeDisabled();
    await act(async () => finish({ user: { id: 'g-1', email: 'demo@gmail.com', personalStudio: null, membershipTier: 'base' } }));
    expect(useCurrentUserStore.getState().user?.id).toBe('g-1');
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
  });

  it('reports API failures without creating a local session', async () => {
    vi.mocked(authApi.google).mockRejectedValue(new Error('network'));
    setup();
    respond();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed/i));
    expect(useCurrentUserStore.getState().user).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('does not submit a missing credential', () => {
    setup();
    const config = sdk.initialize.mock.calls.at(-1)?.[0];
    act(() => config.callback({}));
    expect(authApi.google).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('shows a script error while leaving email sign-in usable', () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    fireEvent.error(document.querySelector('script[src^="https://accounts.google.com/gsi/client"]')!);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('ignores an outstanding response after leaving the login page', async () => {
    let finish!: (value: Awaited<ReturnType<typeof authApi.google>>) => void;
    vi.mocked(authApi.google).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const view = setup();
    respond();
    view.unmount();
    await act(async () => finish({ user: { id: 'late', email: 'demo@gmail.com', personalStudio: null, membershipTier: 'base' } }));
    expect(useCurrentUserStore.getState().user).toBeNull();
  });

  it('does not load Google when no client ID is configured', () => {
    vi.stubGlobal('__GOOGLE_CLIENT_ID__', '');
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(document.querySelector('script[src^="https://accounts.google.com/gsi/client"]')).toBeNull();
    expect(sdk.renderButton).not.toHaveBeenCalled();
  });
});
