import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';

import { MembersModal } from '@/pages/project/chrome/top-bar/MembersModal';
import { useUIStore } from '@/stores/ui';

describe('MembersModal', () => {
  beforeEach(() => {
    useUIStore.setState({ membersModalOpen: false });
  });

  it('is hidden when membersModalOpen is false', () => {
    render(<MembersModal />);
    expect(screen.queryByTestId('members-modal')).not.toBeInTheDocument();
  });

  it('renders header / invite input / 5 stub member rows when open', () => {
    act(() => {
      useUIStore.getState().setMembersModalOpen(true);
    });
    render(<MembersModal />);
    expect(screen.getByTestId('members-modal')).toBeInTheDocument();
    expect(screen.getByText('协作者管理')).toBeInTheDocument();
    expect(screen.getByText('管理项目成员及其权限')).toBeInTheDocument();
    expect(
      screen.getByTestId('members-modal-invite-input'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('members-modal-row-me'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('members-modal-row-pl'),
    ).toBeInTheDocument();
  });

  it('owner row has 所有者 label, non-owner rows have role select', () => {
    act(() => {
      useUIStore.getState().setMembersModalOpen(true);
    });
    render(<MembersModal />);
    // owner row: no role select
    expect(
      screen.queryByTestId('members-modal-role-me'),
    ).not.toBeInTheDocument();
    // editor / viewer rows: role select present
    expect(screen.getByTestId('members-modal-role-yj')).toBeInTheDocument();
    expect(screen.getByTestId('members-modal-role-dm')).toBeInTheDocument();
    expect(screen.getByTestId('members-modal-role-rt')).toBeInTheDocument();
    expect(screen.getByTestId('members-modal-role-pl')).toBeInTheDocument();
  });
});
