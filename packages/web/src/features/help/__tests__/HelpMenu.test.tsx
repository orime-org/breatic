// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HelpMenu } from '@web/features/help/HelpMenu';
import { OFFICIAL_HOME_URL, SUPPORT_EMAIL, TUTORIALS_URL } from '@web/lib/official-home';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

describe('HelpMenu', () => {
  it('points at the official user manual and the support mailbox', () => {
    expect(TUTORIALS_URL).toBe(new URL('tutorials/', OFFICIAL_HOME_URL).href);
    expect(SUPPORT_EMAIL).toBe('support@breatic.ai');
  });

  it('renders a Help trigger that opens the two help entries', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    const trigger = screen.getByTestId('help-menu-trigger');
    expect(trigger).toHaveAccessibleName('Help');
    await user.click(trigger);
    expect(await screen.findByRole('menuitem', { name: /User manual/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Contact support/ })).toBeInTheDocument();
  });

  it('opens the user manual in a new tab', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await user.click(screen.getByTestId('help-menu-trigger'));
    const manual = await screen.findByRole('menuitem', { name: /User manual/ });
    expect(manual).toHaveAttribute('href', TUTORIALS_URL);
    expect(manual).toHaveAttribute('target', '_blank');
    expect(manual.getAttribute('rel')).toContain('noopener');
  });

  it('writes to the support mailbox and shows its address', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await user.click(screen.getByTestId('help-menu-trigger'));
    const contact = await screen.findByRole('menuitem', { name: /Contact support/ });
    expect(contact).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`);
    expect(contact).toHaveTextContent(SUPPORT_EMAIL);
  });

  it('has no a11y violations while open', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await user.click(screen.getByTestId('help-menu-trigger'));
    await screen.findByRole('menuitem', { name: /User manual/ });
    await expectNoA11yViolations(document.body);
  });
});
