import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';

import { MembersModal } from '@/pages/project/chrome/top-bar/MembersModal';
import { useUIStore } from '@/stores/ui';
import { expectNoA11yViolations } from '@/test-utils/a11y';

describe('MembersModal', () => {
  beforeEach(() => {
    useUIStore.setState({ activeOverlayId: null });
  });

  it('is hidden when activeOverlayId is not members-modal', () => {
    render(<MembersModal />);
    expect(screen.queryByTestId('members-modal')).not.toBeInTheDocument();
  });

  it('has no a11y violations when open', async () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    render(<MembersModal />);
    await expectNoA11yViolations(document.body);
  });

  it('renders header / invite input / 5 stub member rows when open', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    render(<MembersModal />);
    expect(screen.getByTestId('members-modal')).toBeInTheDocument();
    expect(screen.getByText('Collaborators')).toBeInTheDocument();
    expect(
      screen.getByText('Manage project members and their roles'),
    ).toBeInTheDocument();
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

  it('owner row has Owner label, non-owner rows have role select', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
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
