// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { OAuthInteractionView } from '@breatic/shared';

import ConnectPage from '@web/pages/connect/ConnectPage';
import ConnectErrorPage from '@web/pages/connect/ConnectErrorPage';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores/current-user';

vi.mock('@web/data/api/oauth-interactions', () => ({
  oauthInteractionsApi: { view: vi.fn(), confirm: vi.fn(), abort: vi.fn() },
}));

import { oauthInteractionsApi } from '@web/data/api/oauth-interactions';

const UID = 'uid-123';
const LOCAL: OAuthInteractionView = { clientName: 'Claude Code', redirectHosts: ['127.0.0.1'], localhostOnly: true };
const WEB: OAuthInteractionView = { clientName: 'claude.ai', redirectHosts: ['claude.ai'], localhostOnly: false };

/**
 * Render the consent page for the interaction.
 * @returns Nothing.
 */
function renderPage(): void {
  render(
    <MemoryRouter initialEntries={[`/connect/${UID}`]}>
      <Routes>
        <Route path='/connect/:uid' element={<ConnectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(oauthInteractionsApi.view).mockReset();
  vi.mocked(oauthInteractionsApi.confirm).mockReset();
  vi.mocked(oauthInteractionsApi.abort).mockReset();
  assign = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
  useCurrentUserStore.setState({ user: { email: 'demo@example.com' } as never });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectPage', () => {
  it('names the agent and where the answer goes, and warns when it goes to this computer', async () => {
    vi.mocked(oauthInteractionsApi.view).mockResolvedValue(LOCAL);
    renderPage();
    expect(await screen.findByText(/Claude Code/)).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1/)).toBeInTheDocument();
    expect(screen.getByText(/this computer/)).toBeInTheDocument();
    expect(screen.getByText(/demo@example\.com/)).toBeInTheDocument();
  });

  it('shows no local warning for an agent on the web', async () => {
    vi.mocked(oauthInteractionsApi.view).mockResolvedValue(WEB);
    renderPage();
    await screen.findByRole('heading', { name: /claude\.ai wants to connect/ });
    expect(screen.queryByText(/this computer/)).not.toBeInTheDocument();
  });

  it('allows the agent and goes where the server says', async () => {
    vi.mocked(oauthInteractionsApi.view).mockResolvedValue(LOCAL);
    vi.mocked(oauthInteractionsApi.confirm).mockResolvedValue({ redirectTo: 'http://localhost:3100/oauth/auth/uid-123' });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(oauthInteractionsApi.confirm).toHaveBeenCalledWith(UID);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:3100/oauth/auth/uid-123'));
  });

  it('refuses the agent and goes where the server says', async () => {
    vi.mocked(oauthInteractionsApi.view).mockResolvedValue(LOCAL);
    vi.mocked(oauthInteractionsApi.abort).mockResolvedValue({ redirectTo: 'http://127.0.0.1:5555/cb?error=access_denied' });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(oauthInteractionsApi.abort).toHaveBeenCalledWith(UID);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5555/cb?error=access_denied'));
  });

  it('keeps both buttons disabled while an answer is being sent', async () => {
    vi.mocked(oauthInteractionsApi.view).mockResolvedValue(LOCAL);
    vi.mocked(oauthInteractionsApi.confirm).mockReturnValue(new Promise(() => {}));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  it('says the request is no longer valid when the server no longer has it', async () => {
    vi.mocked(oauthInteractionsApi.view).mockRejectedValue(new ApiException({ status: 404, code: 'NOT_FOUND', message: 'gone' }));
    renderPage();
    expect(await screen.findByText('This authorization request is no longer valid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('says so when the answer comes after the request expired', async () => {
    vi.mocked(oauthInteractionsApi.view).mockResolvedValue(LOCAL);
    vi.mocked(oauthInteractionsApi.confirm).mockRejectedValue(new ApiException({ status: 404, code: 'NOT_FOUND', message: 'gone' }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('This authorization request is no longer valid')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('offers a retry when the read fails, and shows the request once it succeeds', async () => {
    vi.mocked(oauthInteractionsApi.view).mockRejectedValueOnce(new ApiException({ status: 500, code: 'INTERNAL', message: 'boom' })).mockResolvedValueOnce(LOCAL);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(oauthInteractionsApi.view).toHaveBeenCalledTimes(2);
  });
});

describe('ConnectErrorPage', () => {
  /**
   * Render the error page with a reason.
   * @param reason - The query's reason.
   * @returns Nothing.
   */
  const renderError = (reason: string): void => {
    render(
      <MemoryRouter initialEntries={[`/connect/error?reason=${reason}`]}>
        <Routes>
          <Route path='/connect/error' element={<ConnectErrorPage />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('says the agent cannot connect when its client or callback is wrong', () => {
    renderError('client_invalid');
    expect(screen.getByText('This Agent cannot connect')).toBeInTheDocument();
  });

  it('says the request is no longer valid for an expired one and for an unknown reason', () => {
    renderError('request_expired');
    expect(screen.getByText('This authorization request is no longer valid')).toBeInTheDocument();
  });
});
