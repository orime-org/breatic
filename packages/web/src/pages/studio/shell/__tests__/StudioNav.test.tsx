import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StudioNav } from '@web/pages/studio/shell/StudioNav';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

describe('StudioNav', () => {
  it('renders 4 items: Projects / Assets / Team / Settings', () => {
    render(<StudioNav active='home' onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Projects/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Assets/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Team/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings/i })).toBeInTheDocument();
  });

  it('Assets and Team are disabled in V1', () => {
    render(<StudioNav active='home' onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Assets/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Team/i })).toBeDisabled();
  });

  it('active item gets aria-current=page', () => {
    render(<StudioNav active='settings' onChange={() => {}} />);
    expect(
      screen.getByRole('button', { name: /Settings/i }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen.getByRole('button', { name: /Projects/i }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('clicking an enabled item calls onChange with its key', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StudioNav active='home' onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Settings/i }));
    expect(onChange).toHaveBeenCalledWith('settings');
  });

  it('clicking a disabled item does not call onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StudioNav active='home' onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Assets/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no a11y violations', async () => {
    const { container } = render(<StudioNav active='home' onChange={() => {}} />);
    await expectNoA11yViolations(container);
  });
});
