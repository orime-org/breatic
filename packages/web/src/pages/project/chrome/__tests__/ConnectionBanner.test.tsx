import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectionBanner } from '@/pages/project/chrome/ConnectionBanner';

describe('ConnectionBanner', () => {
  // Wrapper is always mounted (avoids the "TopBar suddenly shoved down
  // by banner" layout shift when status flips to authFailed mid-session
  // — 2026-05-26 user smoke report). visually-hidden states collapse
  // the wrapper via max-height: 0 + aria-hidden: true, but the banner
  // content DOM stays so the show / hide transition animates smoothly.

  it('keeps wrapper mounted but collapsed (max-h-0 + aria-hidden) when status is connected', () => {
    const { container } = render(<ConnectionBanner status='connected' />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper.className).toMatch(/max-h-0/);
    // Banner content DOM is still present (mounted for smooth transition);
    // it just isn't visible because the wrapper clips it.
    expect(screen.getByTestId('connection-banner')).toBeInTheDocument();
  });

  it('keeps wrapper collapsed when status is connecting (avoid flash on brief reconnects)', () => {
    const { container } = render(<ConnectionBanner status='connecting' />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper.className).toMatch(/max-h-0/);
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
