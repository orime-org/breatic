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

  it('shows the role tag with the human label (Owner)', () => {
    setup();
    expect(screen.getByTestId('role-tag')).toHaveTextContent('Owner');
  });

  it('shows the credits chip with the credit count', () => {
    setup({ credits: 7 });
    expect(screen.getByTestId('credits-chip')).toHaveTextContent('7');
  });

  it('switches title to an input on click and commits on Enter', async () => {
    const user = userEvent.setup();
    const { onRename } = setup({ projectName: 'Old' });
    await user.click(screen.getByTestId('title-display'));
    const input = screen.getByTestId('title-input');
    await user.clear(input);
    await user.type(input, 'New name{Enter}');
    expect(onRename).toHaveBeenCalledWith('New name');
  });

  it('renders the home logo link pointing at /studio', () => {
    setup();
    const link = screen.getByLabelText('Home');
    expect(link.getAttribute('href')).toBe('/studio');
  });
});
