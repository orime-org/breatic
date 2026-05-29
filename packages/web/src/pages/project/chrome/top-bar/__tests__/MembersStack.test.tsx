import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MembersStack } from '@web/pages/project/chrome/top-bar/MembersStack';
import { useUIStore } from '@web/stores/ui';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

describe('MembersStack', () => {
  beforeEach(() => {
    useUIStore.setState({
      shareOpen: false,
      activeOverlayId: null,
    });
  });

  it('has no a11y violations', async () => {
    const { container } = render(<MembersStack projectId='p1' />);
    await expectNoA11yViolations(container);
  });

  it('trigger button exposes member count in aria-label', () => {
    render(<MembersStack projectId='p1' />);
    expect(
      screen.getByRole('button', { name: /Project members \(5\)/i }),
    ).toBeInTheDocument();
  });

  it('clicking trigger opens popover with 5 stub member rows', async () => {
    const user = userEvent.setup();
    render(<MembersStack projectId='p1' />);
    await user.click(screen.getByTestId('members-trigger'));
    expect(screen.getByTestId('members-row-me')).toBeInTheDocument();
    expect(screen.getByTestId('members-row-yj')).toBeInTheDocument();
    expect(screen.getByTestId('members-row-pl')).toBeInTheDocument();
    expect(screen.getByText('Songxiu Lei')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('clicking Invite new member closes popover + opens shareOpen', async () => {
    const user = userEvent.setup();
    render(<MembersStack projectId='p1' />);
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-invite-trigger'));
    expect(useUIStore.getState().shareOpen).toBe(true);
    expect(useUIStore.getState().activeOverlayId).toBeNull();
  });

  it('clicking Manage collaborators closes popover + opens members-modal overlay', async () => {
    const user = userEvent.setup();
    render(<MembersStack projectId='p1' />);
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-manage-trigger'));
    expect(useUIStore.getState().activeOverlayId).toBe('members-modal');
    expect(useUIStore.getState().shareOpen).toBe(false);
  });
});
