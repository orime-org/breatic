// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InviteMemberDialog } from '@web/pages/studio/container/dialogs/InviteMemberDialog';

describe('InviteMemberDialog', () => {
  it('submits the typed email with the default member role', async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn();
    render(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={onInvite}
        pending={false}
        error={null}
      />,
    );
    await user.type(screen.getByLabelText('Email'), 'new@x.example');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    expect(onInvite).toHaveBeenCalledWith({
      email: 'new@x.example',
      role: 'member',
    });
  });

  it('does not submit an empty email', async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn();
    render(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={onInvite}
        pending={false}
        error={null}
      />,
    );
    // Submit button is disabled while the email is empty.
    const submit = screen.getByRole('button', { name: 'Send invite' });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(onInvite).not.toHaveBeenCalled();
  });

  it('renders a server error inline as an alert', () => {
    render(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={vi.fn()}
        pending={false}
        error='That email is not registered.'
      />,
    );
    const alert = screen.getByTestId('invite-member-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('That email is not registered.');
  });

  it('disables the submit button while the invite is pending', () => {
    render(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={vi.fn()}
        pending
        error={null}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send invite' })).toBeDisabled();
  });
});
