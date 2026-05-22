import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TopBar } from '@/pages/project/chrome/top-bar/TopBar';
import { expectNoA11yViolations } from '@/test-utils/a11y';

function setup(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  const onRename = vi.fn();
  render(
    <MemoryRouter>
      <TopBar
        projectId='p1'
        projectName='Demo'
        // eslint-disable-next-line jsx-a11y/aria-role -- `role` here is a TopBar component prop (owner | editor | viewer), not a DOM ARIA role
        role='owner'
        credits={42}
        onRename={onRename}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onRename };
}

describe('TopBar', () => {
  it('renders the top-bar landmark', () => {
    setup();
    expect(screen.getByTestId('top-bar')).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    setup();
    await expectNoA11yViolations(document.body);
  });

  it('shows the role tag with the uppercase label (OWNER)', () => {
    setup();
    expect(screen.getByTestId('role-tag')).toHaveTextContent('OWNER');
  });

  it('shows the credits chip with the credit count', () => {
    setup({ credits: 7 });
    expect(screen.getByTestId('credits-chip')).toHaveTextContent('7');
  });

  it('title click swaps to <input>; typing + Enter commits the new name', async () => {
    const user = userEvent.setup();
    const { onRename } = setup({ projectName: 'Old' });
    // Static mode: visible <span>
    const display = screen.getByTestId('title-display');
    expect(display).toBeInTheDocument();
    await user.click(display);
    // Edit mode: <input> autofocused + text selected
    const input = await screen.findByTestId('title-input');
    expect(input.tagName).toBe('INPUT');
    await user.clear(input);
    await user.type(input, 'New name{Enter}');
    expect(onRename).toHaveBeenCalledWith('New name');
    // Back to static mode after commit
    expect(screen.queryByTestId('title-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('title-display')).toBeInTheDocument();
  });

  it('renders the home logo link pointing at /studio', () => {
    setup();
    const link = screen.getByLabelText('Home');
    expect(link.getAttribute('href')).toBe('/studio');
  });

  it('renders both topbar groups (text-icon + icon-only)', () => {
    setup();
    expect(screen.getByTestId('topbar-group-text-icon')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-group-icon-only')).toBeInTheDocument();
  });
});
