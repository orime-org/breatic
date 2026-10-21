// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
      role: 'guest',
    });
  });

  it('keeps Send pressable and says an email is needed when it is empty (inner#1652)', async () => {
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
    const submit = screen.getByRole('button', { name: 'Send invite' });
    expect(submit).not.toBeDisabled();
    await user.click(submit);
    expect(onInvite).not.toHaveBeenCalled();
    expect(screen.getByText('Enter an email address.')).toBeInTheDocument();
    const email = screen.getByLabelText('Email');
    expect(email).toHaveFocus();
    expect(email).toHaveAttribute('aria-invalid', 'true');
    await user.type(email, 'n');
    expect(screen.queryByText('Enter an email address.')).not.toBeInTheDocument();
  });

  it('says the email is not valid instead of sending it (inner#1652)', async () => {
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
    await user.type(screen.getByLabelText('Email'), 'new@x{Enter}');
    expect(onInvite).not.toHaveBeenCalled();
    expect(screen.getByText('Please enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });

  it('ignores a press while the invite is out (inner#1652)', async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn();
    const { rerender } = render(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={onInvite}
        pending={false}
        error={null}
      />,
    );
    await user.type(screen.getByLabelText('Email'), 'new@x.example');
    rerender(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={onInvite}
        pending
        error={null}
      />,
    );
    await user.type(screen.getByLabelText('Email'), '{Enter}');
    expect(onInvite).not.toHaveBeenCalled();
  });

  it('holds the email and role while the invite is out (inner#1652)', () => {
    render(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={vi.fn()}
        pending
        error={null}
      />,
    );
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Role')).toBeDisabled();
  });

  it('leaves the browser out of it: no native email check (inner#1652)', () => {
    render(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={vi.fn()}
        pending={false}
        error={null}
      />,
    );
    expect(screen.getByTestId('invite-member-dialog').querySelector('form')).toHaveAttribute('novalidate');
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('required');
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

  it('marks the submit button busy while the invite is pending, and clears it once answered', () => {
    const { rerender } = render(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={vi.fn()}
        pending
        error={null}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Send invite' });
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(submit).toHaveAttribute('aria-disabled', 'true');

    rerender(
      <InviteMemberDialog
        open
        onOpenChange={vi.fn()}
        onInvite={vi.fn()}
        pending={false}
        error='That email is not registered.'
      />,
    );
    expect(submit).not.toHaveAttribute('aria-busy');
  });
});
