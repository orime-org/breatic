import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThemeToggle } from '@/pages/project/chrome/top-bar/ThemeToggle';
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

  it('opens the theme popover and selecting Dark sets the theme', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByTestId('theme-toggle'));
    await user.click(await screen.findByTestId('theme-option-dark'));
    expect(usePreferencesStore.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('aria-label reflects the current theme (mock § TopBar v4.0 popover)', () => {
    render(<ThemeToggle />);
    expect(screen.getByLabelText('Theme: light')).toBeInTheDocument();
  });
});
