import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MembersStack } from '@/pages/project/chrome/top-bar/MembersStack';
import { useUIStore } from '@/stores/ui';

describe('MembersStack', () => {
  beforeEach(() => {
    useUIStore.setState({
      shareOpen: false,
      membersModalOpen: false,
    });
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
    expect(screen.getByText('所有者')).toBeInTheDocument();
  });

  it('clicking 邀请新成员 closes popover + opens shareOpen', async () => {
    const user = userEvent.setup();
    render(<MembersStack projectId='p1' />);
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-invite-trigger'));
    expect(useUIStore.getState().shareOpen).toBe(true);
    expect(useUIStore.getState().membersModalOpen).toBe(false);
  });

  it('clicking 查看完整管理 closes popover + opens membersModalOpen', async () => {
    const user = userEvent.setup();
    render(<MembersStack projectId='p1' />);
    await user.click(screen.getByTestId('members-trigger'));
    await user.click(screen.getByTestId('members-manage-trigger'));
    expect(useUIStore.getState().membersModalOpen).toBe(true);
    expect(useUIStore.getState().shareOpen).toBe(false);
  });
});
