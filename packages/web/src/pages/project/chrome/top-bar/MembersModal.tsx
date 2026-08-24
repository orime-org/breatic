// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@web/lib/toast';

import { Button } from '@web/components/ui/button';
import { StudioAvatar } from '@web/ui/StudioAvatar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { useTranslation } from '@web/i18n/use-translation';
import { expiresInLabel } from '@web/lib/expires-in';
import { membersApi } from '@web/data/api/members';
import type { Member, MemberRole } from '@web/data/api/members';
import { projectsApi } from '@web/data/api/projects';

interface MembersModalProps {
  projectId?: string;
  /**
   * The project's roster. Required for the same reason as the stack's: this
   * carried its own copy of the same five invented people as a default.
   */
  members: ReadonlyArray<Member>;
  currentUserId?: string;
  /** Viewer's own role on this project; the transfer section is owner-only. */
  currentUserRole?: MemberRole;
}

const ROLE_OPTIONS: ReadonlyArray<{
  value: Exclude<MemberRole, 'owner'>;
  labelKey: 'role.editor' | 'role.viewer';
}> = [
  { value: 'editor', labelKey: 'role.editor' },
  { value: 'viewer', labelKey: 'role.viewer' },
];

/**
 * Members management modal — opened by the "Manage collaborators" button
 * inside `<MembersStack>`'s popover.
 *
 * Manage-only: inviting collaborators lives in the ShareDialog (email-only
 * invite-confirm handshake). This dialog manages the EXISTING roster:
 *   - Role select on each non-owner row calls membersApi.setRole.
 *   - Remove button on each non-owner row opens a confirm AlertDialog;
 *     confirming calls membersApi.remove (removal is destructive — the
 *     collaborator loses access — so it is gated behind a second step).
 *   - Subtitle below each member name shows their email.
 *
 * Spec: access-permission design (2026-05-28) § 5.
 * @param root0 - Members modal props.
 * @param root0.projectId - Id of the project whose membership is managed; role/remove calls target it.
 * @param root0.members - Members to list.
 * @param root0.currentUserId - Viewer's user id, used to mark and protect their own row.
 * @param root0.currentUserRole - Viewer's own project role; gates the owner-only transfer section.
 * @returns the collaborator management dialog with role and remove controls.
 */
export function MembersModal({
  projectId,
  members,
  currentUserId,
  currentUserRole,
}: MembersModalProps): React.JSX.Element {
  const t = useTranslation();
  const isOwner = currentUserRole === 'owner';
  const canTransfer =
    isOwner && projectId !== undefined && projectId !== 'demo';
  const [open, setOpen] = useExclusiveOverlay('members-modal');
  const [pendingRowId, setPendingRowId] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<Member | null>(null);
  const queryClient = useQueryClient();

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
      await queryClient.invalidateQueries({
        queryKey: ['project-members', projectId],
      });
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
      await queryClient.invalidateQueries({
        queryKey: ['project-members', projectId],
      });
      toast.success(t('members.modal.removeSuccess'));
      // Close the confirm dialog only on success — a failure leaves it open
      // with the error toast so the owner can retry.
      setConfirmRemove(null);
    } catch {
      toast.error(t('members.modal.removeFailed'));
    } finally {
      setPendingRowId(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid='members-modal'>
          <DialogHeader>
            <DialogTitle>{t('members.modal.title')}</DialogTitle>
            <DialogDescription>
              {t('members.modal.description')}
            </DialogDescription>
          </DialogHeader>

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
                    onRemove={() => setConfirmRemove(m)}
                  />
                </li>
              ))}
            </ul>

            {canTransfer && projectId ? (
              <TransferOwnershipSection projectId={projectId} members={members} />
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmRemove !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRemove(null);
        }}
      >
        <AlertDialogContent data-testid='members-modal-remove-confirm'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('members.modal.removeConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRemove
                ? t('members.modal.removeConfirmBody', {
                  name: confirmRemove.name,
                })
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={pendingRowId !== null}
              onClick={(event) => {
                // Keep the dialog mounted until handleRemove's success path
                // closes it, so a failure leaves it open with the error toast.
                event.preventDefault();
                if (confirmRemove) void handleRemove(confirmRemove);
              }}
              data-testid='members-modal-remove-confirm-action'
            >
              {t('members.modal.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface TransferOwnershipSectionProps {
  projectId: string;
  members: ReadonlyArray<Member>;
}

/**
 * Owner-only "Transfer ownership" section pinned to the bottom of the members
 * modal (Danger-Zone convention). Expands inline to a recipient picker whose
 * options are the backend's transfer candidates (project members who are also
 * non-guest studio members) merged with the already-loaded display profiles —
 * so it never offers a recipient the backend would reject. Sending is a
 * two-step handshake: it dispatches a request the recipient accepts via their
 * bell; no role change until then.
 * @param root0 - Transfer section props.
 * @param root0.projectId - The project whose ownership may be transferred.
 * @param root0.members - The loaded member roster (source of display names).
 * @returns the transfer section (collapsed button, or the inline picker).
 */
function TransferOwnershipSection({
  projectId,
  members,
}: TransferOwnershipSectionProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = React.useState(false);
  const [selected, setSelected] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);
  const liveKey = React.useMemo(
    () => ['project-transfer', 'live', projectId],
    [projectId],
  );

  // A project has one owner, so it can hold only one outstanding offer. While
  // it does, this section is that offer's status rather than a second picker —
  // sending again would just answer 409.
  const liveQuery = useQuery({
    queryKey: liveKey,
    queryFn: () => projectsApi.liveTransfer(projectId),
    // Polls like the bell does. The offer can end without this tab doing
    // anything — the recipient accepts or declines from their own — and a
    // surface that never refetches keeps a Withdraw button over an offer that
    // is already over, which answers 404 and reads as a failure.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const live = liveQuery.data ?? null;
  const recipientName =
    members.find((m) => m.userId === live?.toUserId)?.name ?? '';

  /**
   * Withdraws the outstanding offer, freeing the project's slot at once.
   * @throws {never} network / API errors are caught and surfaced as an error toast.
   */
  async function handleWithdraw(): Promise<void> {
    if (!live || withdrawing) return;
    setWithdrawing(true);
    try {
      await projectsApi.withdrawTransfer(projectId, live.id);
      toast.success(t('members.modal.transferWithdrawn'));
      await queryClient.invalidateQueries({ queryKey: liveKey });
    } catch {
      toast.error(t('members.modal.transferWithdrawFailed'));
    } finally {
      setWithdrawing(false);
    }
  }

  const candidatesQuery = useQuery({
    queryKey: ['transfer-candidates', projectId],
    queryFn: () => membersApi.transferCandidates(projectId),
    enabled: expanded,
  });
  const candidateIds = new Set(
    (candidatesQuery.data ?? []).map((c) => c.userId),
  );
  const candidates = members.filter((m) => candidateIds.has(m.userId));

  /**
   * Sends the ownership-transfer request to the picked recipient, then collapses.
   * @throws {never} network / API errors are caught and surfaced as an error toast.
   */
  async function handleSend(): Promise<void> {
    if (!selected || sending) return;
    setSending(true);
    try {
      await projectsApi.transferOwner(projectId, selected);
      const name = candidates.find((c) => c.userId === selected)?.name ?? '';
      toast.success(t('members.modal.transferSuccess', { name }));
      setExpanded(false);
      setSelected('');
      // The section flips to its pending state off this read.
      await queryClient.invalidateQueries({ queryKey: liveKey });
    } catch {
      toast.error(t('members.modal.transferFailed'));
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className='mt-3 border-t border-border pt-3'
      data-testid='members-modal-transfer'
    >
      <div className='flex items-start justify-between gap-3'>
        <div className='flex min-w-0 flex-col gap-0.5'>
          <span className='text-sm font-medium text-foreground'>
            {t('members.modal.transferTitle')}
          </span>
          <span className='text-xs text-muted-foreground'>
            {t('members.modal.transferHint')}
          </span>
        </div>
        {live ? (
          <Button
            variant='outline'
            size='sm'
            className='h-8 shrink-0 text-xs'
            disabled={withdrawing}
            onClick={() => void handleWithdraw()}
            data-testid='members-modal-transfer-withdraw'
          >
            {t('members.modal.transferWithdraw')}
          </Button>
        ) : !expanded ? (
          <Button
            variant='outline'
            size='sm'
            className='h-8 shrink-0 text-xs'
            onClick={() => setExpanded(true)}
            data-testid='members-modal-transfer-open'
          >
            {t('members.modal.transferButton')}
          </Button>
        ) : null}
      </div>

      {live ? (
        <div
          className='mt-3 flex items-center gap-2 text-xs text-muted-foreground'
          data-testid='members-modal-transfer-pending'
        >
          <span>
            {recipientName
              ? t('members.modal.transferPending', { name: recipientName })
              : t('members.modal.transferPendingUnnamed')}
          </span>
          <span data-testid='members-modal-transfer-expiry'>
            {expiresInLabel(live.expiresAt, t)}
          </span>
        </div>
      ) : expanded ? (
        <div
          className='mt-3 flex flex-col gap-3'
          data-testid='members-modal-transfer-panel'
        >
          {candidatesQuery.isLoading ? (
            <span className='text-xs text-muted-foreground'>…</span>
          ) : candidates.length === 0 ? (
            <span className='text-xs text-muted-foreground'>
              {t('members.modal.transferNoCandidates')}
            </span>
          ) : (
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger
                className='h-9 text-sm'
                data-testid='members-modal-transfer-select'
                aria-label={t('members.modal.transferSelectPlaceholder')}
              >
                <SelectValue
                  placeholder={t('members.modal.transferSelectPlaceholder')}
                />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.userId} value={c.userId}>
                    {c.email ? `${c.name} · ${c.email}` : c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className='flex items-center justify-end gap-2'>
            <Button
              variant='outline'
              size='sm'
              className='h-8 text-xs'
              onClick={() => {
                setExpanded(false);
                setSelected('');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant='destructive'
              size='sm'
              className='h-8 text-xs'
              disabled={!selected || sending}
              onClick={() => void handleSend()}
              data-testid='members-modal-transfer-send'
            >
              {t('members.modal.transferSend')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
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
      <StudioAvatar
        name={member.name}
        type='personal'
        avatarUrl={member.avatarUrl ?? null}
        size='md'
      />
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
