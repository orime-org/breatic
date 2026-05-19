import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThemeToggle } from '../ThemeToggle';
import { usePreferencesStore } from '@/stores';

describe('ThemeToggle', () => {
  beforeEach(() => {
    usePreferencesStore.getState().setTheme('light');
    document.documentElement.dataset.theme = 'light';
  });

  it('mirrors the current theme onto <html data-theme>', () => {
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('clicking toggles theme light → dark', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByTestId('theme-toggle'));
    expect(usePreferencesStore.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('aria-label tracks the next state (Switch to dark theme)', () => {
    render(<ThemeToggle />);
    expect(
      screen.getByLabelText('Switch to dark theme'),
    ).toBeInTheDocument();
  });
});
