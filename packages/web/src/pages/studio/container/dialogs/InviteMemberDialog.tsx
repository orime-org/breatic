// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import type { GrantableStudioRole } from '@web/data/api/studios';
import { useTranslation } from '@web/i18n/use-translation';

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a valid email + role on submit; the parent runs the mutation. */
  onInvite: (values: { email: string; role: GrantableStudioRole }) => void;
  /** Whether the invite mutation is in flight (disables the submit button). */
  pending: boolean;
  /**
   * A server-side error from the last invite attempt, shown inline (e.g. "email
   * not registered" / "already a member"). `null` clears the inline error.
   */
  error: string | null;
}

/**
 * The invite-member dialog (spec §3.7) — a small form (registered email + a
 * `creator` / `member` role) that an admin uses to add someone to a team
 * studio. On a valid submit it reports the values to the parent (which runs the
 * mutation) and keeps the dialog open until the parent closes it on success, so
 * a server error (`404` email not registered / `409` already a member) can be
 * shown inline without losing the typed input. The role defaults to `member`.
 * @param props the open state, submit callback, pending flag and inline error.
 * @param props.open whether the dialog is open.
 * @param props.onOpenChange called when the open state should change.
 * @param props.onInvite called with the entered email + role on a valid submit.
 * @param props.pending whether the invite mutation is in flight.
 * @param props.error a server-side error to show inline, or `null`.
 * @returns the invite-member dialog.
 */
export function InviteMemberDialog({
  open,
  onOpenChange,
  onInvite,
  pending,
  error,
}: InviteMemberDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<GrantableStudioRole>('member');

  // Reset the form whenever the dialog opens, so a re-open starts clean (the
  // parent owns the server error, which it clears on open).
  React.useEffect(() => {
    if (open) {
      setEmail('');
      setRole('member');
    }
  }, [open]);

  /**
   * Validate the form and report the values on a successful submit.
   * @param event the form submit event.
   */
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const trimmed = email.trim();
    if (trimmed === '') {
      return;
    }
    onInvite({ email: trimmed, role });
  };

  const emailId = 'invite-member-email';
  const roleId = 'invite-member-role';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid='invite-member-dialog'
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('studio.container.members.inviteTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody className='flex flex-col gap-4'>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor={emailId}>
                {t('studio.container.members.inviteEmailLabel')}
              </Label>
              <Input
                id={emailId}
                type='email'
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t(
                  'studio.container.members.inviteEmailPlaceholder',
                )}
                required
                autoComplete='off'
              />
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor={roleId}>
                {t('studio.container.members.inviteRoleLabel')}
              </Label>
              <Select
                value={role}
                onValueChange={(next) =>
                  setRole(next as GrantableStudioRole)
                }
              >
                <SelectTrigger id={roleId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='member'>
                    {t('studio.container.members.roleMember')}
                  </SelectItem>
                  <SelectItem value='creator'>
                    {t('studio.container.members.roleCreator')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error !== null ? (
              <p
                role='alert'
                className='text-xs text-status-error-foreground'
                data-testid='invite-member-error'
              >
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
            >
              {t('studio.container.dialog.cancel')}
            </Button>
            <Button type='submit' disabled={pending || email.trim() === ''}>
              {t('studio.container.members.inviteSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
