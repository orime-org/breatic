// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The frame every sign-in, sign-up and recovery page renders in: a page
 * header and footer around the centred card.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { AuthCardShell } from '@web/pages/auth/_shared/AuthCardShell';
import { OFFICIAL_HOME_URL, PRIVACY_URL, TERMS_URL } from '@web/lib/official-home';

/**
 * Render the shell around a stand-in form.
 * @returns the render result.
 */
function renderShell(showVersion = false): ReturnType<typeof render> {
  return render(
    <AuthCardShell title='Sign in' showVersion={showVersion} footer={<span>Card footer</span>}>
      <form aria-label='Stand-in form' />
    </AuthCardShell>,
  );
}

describe('AuthCardShell', () => {
  it('puts a page header, the card and a page footer in that order', () => {
    renderShell();
    const header = screen.getByTestId('auth-page-header');
    const main = screen.getByRole('main');
    const footer = screen.getByTestId('auth-page-footer');
    expect(header.nextElementSibling).toBe(main);
    expect(main.nextElementSibling).toBe(footer);
  });

  it('keeps the card inside the main region', () => {
    renderShell();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(within(main).getByRole('form', { name: 'Stand-in form' })).toBeInTheDocument();
    expect(within(main).getByText('Card footer')).toBeInTheDocument();
  });

  it('shows the brand in the header, linking the official site in a new tab', () => {
    renderShell();
    const home = within(screen.getByTestId('auth-page-header')).getByRole('link', { name: 'Home' });
    expect(home).toHaveAttribute('href', OFFICIAL_HOME_URL);
    expect(home).toHaveAttribute('target', '_blank');
    expect(home.getAttribute('rel')).toContain('noopener');
    expect(home).toHaveTextContent('Breatic');
    expect(within(home).getByTestId('top-bar-logo')).toBeInTheDocument();
  });

  it('offers the language and theme switches in the header', () => {
    renderShell();
    const header = screen.getByTestId('auth-page-header');
    expect(within(header).getByTestId('lang-trigger')).toBeInTheDocument();
    expect(within(header).getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('links the terms and the privacy policy from the page footer in a new tab', () => {
    renderShell();
    const footer = screen.getByTestId('auth-page-footer');
    const terms = within(footer).getByRole('link', { name: 'Terms of Service' });
    const privacy = within(footer).getByRole('link', { name: 'Privacy Policy' });
    expect(terms).toHaveAttribute('href', TERMS_URL);
    expect(privacy).toHaveAttribute('href', PRIVACY_URL);
    for (const link of [terms, privacy]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    }
  });
});


afterEach(() => { vi.unstubAllEnvs(); });

describe('auth card build version', () => {
  it.each([
    [true, '0.0.6', 'Beta v0.0.6'],
    [true, '0.0.6-rc.1', 'Beta v0.0.6-rc.1'],
    [true, '', 'dev'],
    [true, '0.0.0-dev', 'dev'],
    [false, '0.0.6', 'dev'],
  ])('shows the build identity for production=%s, version=%s', (production, version, label) => {
    vi.stubEnv('PROD', production);
    vi.stubEnv('VITE_RELEASE_VERSION', version);
    vi.stubEnv('VITE_APP_VERSION', 'a'.repeat(40));
    renderShell(true);
    const header = screen.getByRole('heading', { name: 'Sign in' }).closest('header');
    expect(header).toHaveTextContent(label);
    expect(header).not.toHaveTextContent('a'.repeat(40));
  });

  it('keeps other account cards free of the version label', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_RELEASE_VERSION', '0.0.6');
    renderShell();
    expect(screen.queryByText('Beta v0.0.6')).not.toBeInTheDocument();
    expect(screen.queryByText('dev')).not.toBeInTheDocument();
  });
});
