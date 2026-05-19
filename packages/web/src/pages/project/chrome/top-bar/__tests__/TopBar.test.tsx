import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TopBar } from '../TopBar';

function setup(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  const onRename = vi.fn();
  render(
    <MemoryRouter>
      <TopBar
        projectId='p1'
        projectName='Demo'
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

  it('shows the role tag with the uppercase label (OWNER)', () => {
    setup();
    expect(screen.getByTestId('role-tag')).toHaveTextContent('OWNER');
  });

  it('shows the credits chip with the credit count', () => {
    setup({ credits: 7 });
    expect(screen.getByTestId('credits-chip')).toHaveTextContent('7');
  });

  it('title is inline contenteditable and commits via blur (mock § TopBar v4.0)', async () => {
    const user = userEvent.setup();
    const { onRename } = setup({ projectName: 'Old' });
    const title = screen.getByTestId('title-display');
    expect(title.getAttribute('contenteditable')).toBe('true');
    title.focus();
    // Simulate inline edit then blur commit
    title.innerText = 'New name';
    await user.click(document.body); // blur
    expect(onRename).toHaveBeenCalledWith('New name');
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
