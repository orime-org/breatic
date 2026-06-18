// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';

import { MembersModal } from '@web/pages/project/chrome/top-bar/MembersModal';
import { useUIStore } from '@web/stores/ui';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

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

  it('renders header / 5 stub member rows when open', () => {
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
      screen.getByTestId('members-modal-row-me'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('members-modal-row-pl'),
    ).toBeInTheDocument();
  });

  it('is manage-only — no invite input / send button (invite lives in ShareDialog)', () => {
    act(() => {
      useUIStore.getState().setActiveOverlayId('members-modal');
    });
    render(<MembersModal />);
    expect(
      screen.queryByTestId('members-modal-invite-input'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('members-modal-invite-send'),
    ).not.toBeInTheDocument();
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
