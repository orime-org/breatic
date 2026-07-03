// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectionBanner } from '@web/pages/project/chrome/ConnectionBanner';

describe('ConnectionBanner', () => {
  // Banner is conditional-render (early return null) when status is
  // connected / connecting — no max-height transition. Layout-shift
  // concern that motivated always-mounted wrapper is gone now that
  // the banner is `fixed top-0 z-50` (outside document flow), so
  // mount/unmount no longer pushes TopBar. Per 2026-05-26 user spec,
  // banner + workspace-overlay must appear/disappear on the same frame
  // — both are now plain conditional renders, no entry animation.

  it('renders nothing when status is connected', () => {
    const { container } = render(<ConnectionBanner status='connected' />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when status is connecting (avoid flash on brief reconnects)', () => {
    const { container } = render(<ConnectionBanner status='connecting' />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the authFailed banner with re-login action', async () => {
    const user = userEvent.setup();
    const onReLogin = vi.fn();
    render(<ConnectionBanner status='authFailed' onReLogin={onReLogin} />);
    const banner = screen.getByTestId('connection-banner');
    expect(banner).toHaveAttribute('data-status', 'authFailed');
    await user.click(screen.getByTestId('connection-banner-relogin'));
    expect(onReLogin).toHaveBeenCalledTimes(1);
  });

  it('renders the disconnected banner with reload action', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    render(<ConnectionBanner status='disconnected' onReload={onReload} />);
    const banner = screen.getByTestId('connection-banner');
    expect(banner).toHaveAttribute('data-status', 'disconnected');
    // No re-login button in disconnected state
    expect(
      screen.queryByTestId('connection-banner-relogin'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId('connection-banner-reload'));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('authFailed paints the status-error triple, not the old static red (#1549)', () => {
    render(<ConnectionBanner status='authFailed' onReLogin={() => {}} />);
    const surface = screen.getByTestId('connection-banner-surface');
    expect(surface).toHaveClass(
      'bg-status-error-bg',
      'text-status-error-foreground',
      'border-status-error-border',
    );
    expect(screen.getByTestId('connection-banner').className).not.toContain(
      'bg-red-900',
    );
  });

  it('disconnected paints the status-warning triple, not the old static amber (#1549)', () => {
    render(<ConnectionBanner status='disconnected' onReload={() => {}} />);
    const surface = screen.getByTestId('connection-banner-surface');
    expect(surface).toHaveClass(
      'bg-status-warning-bg',
      'text-status-warning-foreground',
      'border-status-warning-border',
    );
    expect(screen.getByTestId('connection-banner').className).not.toContain(
      'bg-amber-700',
    );
  });

  it('banner buttons follow the tone (identity text/border, no white-on-dark override)', () => {
    render(<ConnectionBanner status='authFailed' onReLogin={() => {}} />);
    const btn = screen.getByTestId('connection-banner-relogin');
    expect(btn).toHaveClass(
      'text-status-error-foreground',
      'border-status-error-border',
    );
    expect(btn.className).not.toContain('text-white');
  });

  it('authFailed banner shows reload too if onReload is provided', () => {
    render(
      <ConnectionBanner
        status='authFailed'
        onReLogin={() => {}}
        onReload={() => {}}
      />,
    );
    expect(
      screen.getByTestId('connection-banner-relogin'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('connection-banner-reload')).toBeInTheDocument();
  });
});
