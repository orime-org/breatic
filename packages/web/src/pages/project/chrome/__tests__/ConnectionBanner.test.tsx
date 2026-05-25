import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectionBanner } from '@/pages/project/chrome/ConnectionBanner';

describe('ConnectionBanner', () => {
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
