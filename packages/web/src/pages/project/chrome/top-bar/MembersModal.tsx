// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Send } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@web/components/ui/avatar';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Separator } from '@web/components/ui/separator';
import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { useTranslation } from '@web/i18n/use-translation';
import { membersApi } from '@web/data/api/members';
import type { Member, MemberRole } from '@web/data/api/members';

interface MembersModalProps {
  projectId?: string;
  members?: ReadonlyArray<Member>;
  currentUserId?: string;
}

const STUB_MEMBERS: ReadonlyArray<Member> = [
  { id: 'me', userId: 'u-me', name: 'Songxiu Lei', email: 'sx@example.com', role: 'owner' },
  { id: 'yj', userId: 'u-yj', name: 'Yuki Jia', email: 'yj@example.com', role: 'editor' },
  { id: 'dm', userId: 'u-dm', name: 'Diana Marquez', email: 'dm@example.com', role: 'editor' },
  { id: 'rt', userId: 'u-rt', name: 'Ryo Tanaka', email: 'rt@example.com', role: 'viewer' },
  { id: 'pl', userId: 'u-pl', name: 'Priya Lokesh', email: 'pl@example.com', role: 'viewer' },
];

const ROLE_OPTIONS: ReadonlyArray<{
  value: Exclude<MemberRole, 'owner'>;
  labelKey: 'role.editor' | 'role.viewer';
}> = [
  { value: 'editor', labelKey: 'role.editor' },
  { value: 'viewer', labelKey: 'role.viewer' },
];

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Derives up-to-two uppercase initials from a member's display name.
 * @param name - Member display name to abbreviate.
 * @returns the initials, or `?` when the name is empty.
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Members management modal — opened by the "Manage collaborators" button
 * inside `<MembersStack>`'s popover.
 *
 * 2026-05-28 spec § 5 wires this dialog to the backend:
 *   - Invite input takes a plain email (the previous "Email or user ID"
 *     copy is gone; user IDs were never a stable invite identifier).
 *   - Role select on each non-owner row calls membersApi.setRole.
 *   - Remove button on each non-owner row calls membersApi.remove.
 *   - Subtitle below each member name shows their email (previously
 *     showed lowercased initials, which user 2026-05-28 explicitly
 *     called out as wrong).
 *
 * Spec: access-permission design (2026-05-28) § 5.
 * @param root0 - Members modal props.
 * @param root0.projectId - Id of the project whose membership is managed; invite/role/remove calls target it.
 * @param root0.members - Members to list; defaults to stub data when not supplied.
 * @param root0.currentUserId - Viewer's user id, used to mark and protect their own row.
 * @returns the collaborator management dialog with invite, role and remove controls.
 */
export function MembersModal({
  projectId,
  members = STUB_MEMBERS,
  currentUserId,
}: MembersModalProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = useExclusiveOverlay('members-modal');
  const [invite, setInvite] = React.useState('');
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [inviteSubmitting, setInviteSubmitting] = React.useState(false);
  const [pendingRowId, setPendingRowId] = React.useState<string | null>(null);

  /**
   * Validates the invite email and sends an invitation, showing a success or error toast.
   */
  async function handleInvite(): Promise<void> {
    if (!projectId || inviteSubmitting) return;
    const trimmed = invite.trim();
    if (!EMAIL_RX.test(trimmed)) {
      setInviteError(t('members.modal.invalidEmail'));
      return;
    }
    setInviteError(null);
    setInviteSubmitting(true);
    try {
      await membersApi.invite(projectId, { email: trimmed, role: 'viewer' });
      toast.success(t('members.modal.inviteSent'));
      setInvite('');
    } catch {
      toast.error(t('members.modal.inviteFailed'));
    } finally {
      setInviteSubmitting(false);
    }
  }

  /**
   * Changes a member's role on the backend, showing a success or error toast.
   * @param member - Member whose role is being changed.
   * @param next - New non-owner role to assign.
   */
  async function handleSetRole(
    member: Member,
    next: Exclude<MemberRole, 'owner'>,
  ): Promise<void> {
    if (!projectId || pendingRowId) return;
    setPendingRowId(member.id);
    try {
      await membersApi.setRole(projectId, member.id, next);
      toast.success(t('members.modal.roleChanged'));
    } catch {
      toast.error(t('members.modal.roleChangeFailed'));
    } finally {
      setPendingRowId(null);
    }
  }

  /**
   * Removes a member from the project, showing a success or error toast.
   * @param member - Member to remove.
   */
  async function handleRemove(member: Member): Promise<void> {
    if (!projectId || pendingRowId) return;
    setPendingRowId(member.id);
    try {
      await membersApi.remove(projectId, member.id);
      toast.success(t('members.modal.removeSuccess'));
    } catch {
      toast.error(t('members.modal.removeFailed'));
    } finally {
      setPendingRowId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid='members-modal'>
        <DialogHeader>
          <DialogTitle>{t('members.modal.title')}</DialogTitle>
          <DialogDescription>{t('members.modal.description')}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className='flex flex-col gap-2'>
            <div className='text-2xs font-medium uppercase tracking-wide text-muted-foreground'>
              {t('members.modal.inviteSection')}
            </div>
            <div className='flex items-center gap-2'>
              <Input
                type='email'
                autoComplete='email'
                value={invite}
                onChange={(e) => {
                  setInvite(e.target.value);
                  if (inviteError) setInviteError(null);
                }}
                placeholder={t('members.modal.invitePlaceholder')}
                className='h-9 flex-1 text-sm'
                data-testid='members-modal-invite-input'
                disabled={inviteSubmitting}
                aria-invalid={!!inviteError || undefined}
              />
              <Button
                size='form'
                disabled={invite.trim().length === 0 || inviteSubmitting}
                onClick={handleInvite}
                data-testid='members-modal-invite-send'
              >
                <Send className='h-4 w-4' />
                {inviteSubmitting
                  ? t('members.modal.inviteSending')
                  : t('members.modal.inviteButton')}
              </Button>
            </div>
            {inviteError ? (
              <p className='text-xs text-status-error-foreground' role='alert'>
                {inviteError}
              </p>
            ) : null}
          </div>
        </DialogBody>

        <Separator />

        <DialogBody>
          <div className='flex items-center justify-between'>
            <span className='text-2xs font-medium uppercase tracking-wide text-muted-foreground'>
              {t('members.modal.membersSection', { count: members.length })}
            </span>
            <span className='text-2xs text-muted-foreground'>
              {t('members.modal.ownerNote')}
            </span>
          </div>
          <ul className='flex flex-col divide-y divide-border'>
            {members.map((m) => (
              <li key={m.id} data-testid={`members-modal-row-${m.id}`}>
                <ModalMemberRow
                  member={m}
                  isMe={
                    currentUserId !== undefined && m.userId === currentUserId
                  }
                  pending={pendingRowId === m.id}
                  onSetRole={(r) => handleSetRole(m, r)}
                  onRemove={() => handleRemove(m)}
                />
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

interface ModalMemberRowProps {
  member: Member;
  isMe: boolean;
  pending: boolean;
  onSetRole: (role: Exclude<MemberRole, 'owner'>) => void;
  onRemove: () => void;
}

/**
 * One member row inside the modal — avatar, name/email, role select and remove button.
 * @param root0 - Member row props.
 * @param root0.member - Member rendered by this row.
 * @param root0.isMe - Whether this row is the current viewer (role becomes static, not editable).
 * @param root0.pending - Whether a role/remove mutation is in flight for this row (disables controls).
 * @param root0.onSetRole - Called with the new role when the viewer changes this member's role.
 * @param root0.onRemove - Called when the viewer removes this member.
 * @returns the member row with its role and remove controls.
 */
function ModalMemberRow({
  member,
  isMe,
  pending,
  onSetRole,
  onRemove,
}: ModalMemberRowProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-3 py-2'>
      <Avatar className='h-9 w-9 shrink-0'>
        <AvatarFallback className='text-xs font-semibold'>
          {initialsOf(member.name)}
        </AvatarFallback>
      </Avatar>
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='truncate text-sm font-medium text-foreground'>
          {member.name}
          {isMe ? (
            <span className='ml-1 text-xs text-muted-foreground'>
              {t('members.modal.isMe')}
            </span>
          ) : null}
        </span>
        <span className='truncate text-xs text-muted-foreground'>
          {member.email}
        </span>
      </div>
      {member.role === 'owner' || isMe ? (
        <span className='shrink-0 text-sm font-medium text-foreground'>
          {member.role === 'owner' ? t('role.owner') : t('role.' + (member.role === 'editor' ? 'editor' : 'viewer'))}
        </span>
      ) : (
        <Select
          value={member.role}
          disabled={pending}
          onValueChange={(v) => onSetRole(v as Exclude<MemberRole, 'owner'>)}
        >
          <SelectTrigger
            className='h-8 w-24 text-sm'
            data-testid={`members-modal-role-${member.id}`}
            aria-label={t('members.modal.roleSelectAria', { name: member.name })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {member.role !== 'owner' && !isMe ? (
        <Button
          variant='outline'
          size='sm'
          className='h-8 px-3 text-xs'
          disabled={pending}
          onClick={onRemove}
          data-testid={`members-modal-remove-${member.id}`}
        >
          {t('members.modal.remove')}
        </Button>
      ) : null}
    </div>
  );
}
