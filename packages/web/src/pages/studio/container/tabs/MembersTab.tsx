// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

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
import { Button } from '@web/components/ui/button';
import {
  studiosApi,
  type GrantableStudioRole,
} from '@web/data/api/studios';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { InviteMemberDialog } from '@web/pages/studio/container/dialogs/InviteMemberDialog';
import { MemberRowMenu } from '@web/pages/studio/container/tabs/MemberRowMenu';
import type { StudioMember } from '@web/pages/studio/container/container-types';
import type {
  StudioRole,
  StudioType,
} from '@web/pages/studio/shared/studio-types';

interface MembersTabProps {
  /** The studio's URL handle — the path param for every member mutation. */
  slug: string;
  members: readonly StudioMember[];
  /** Invite / remove / role changes are Admin-only (DD §5.2); `null` = guest. */
  studioRole: StudioRole | null;
  /**
   * Personal studios are permanently single-member (decision A, 2026-06-08): the tab
   * is read-only — no invite button, no per-member actions.
   */
  studioType: StudioType;
}

/** The member targeted by a confirm dialog, tagged with which action. */
type Confirm =
  | { kind: 'remove'; member: StudioMember }
  | { kind: 'transfer'; member: StudioMember }
  | null;

/**
 * The Members tab (spec §3.7). Lists members (avatar / name / email / studio
 * role / join date). For a **team** studio the "Invite member" action + the
 * per-member row menu show to Admins only (DD §5.2). A **personal** studio is
 * single-member: a read-only roster (just the creator) with no invite and no row
 * actions, plus a note that personal studios cannot invite (decision A, 2026-06-08).
 *
 * Member management (slice 3) is owned here: invite / change-role / remove /
 * transfer-admin run as React Query mutations that invalidate the shared
 * members query (`['studio', slug, 'members']`, the same key
 * `StudioContainerPage` reads) on success, so the table refetches the
 * authoritative server state — no optimistic cache writes, which avoids the
 * microtask-race trap (memory `feedback_react_query_optimistic_microtask_race`)
 * entirely. Destructive actions (remove, transfer-admin) route through a
 * confirm dialog; errors surface as a `sonner` toast, except the invite dialog
 * which shows server errors inline.
 * @param props the studio slug, members, the viewer's studio role and type.
 * @param props.slug the studio's URL handle.
 * @param props.members the studio members.
 * @param props.studioRole the viewer's studio role.
 * @param props.studioType whether the studio is personal or team.
 * @returns the Members tab content.
 */
export function MembersTab({
  slug,
  members,
  studioRole,
  studioType,
}: MembersTabProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  // Manage = invite + per-member actions. Off for personal studios (always
  // single-member) and for non-admins.
  const canManage = studioRole === 'admin' && studioType === 'team';

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<Confirm>(null);

  /**
   * Refetch the authoritative members list after a successful mutation.
   * @returns once the members query has been invalidated.
   */
  const invalidateMembers = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['studio', slug, 'members'] });

  const inviteMutation = useMutation({
    mutationFn: (input: { email: string; role: GrantableStudioRole }) =>
      studiosApi.inviteMember(slug, input),
    onSuccess: async () => {
      await invalidateMembers();
      setInviteOpen(false);
      setInviteError(null);
      toast.success(t('studio.container.members.inviteSuccess'));
    },
    onError: (err) => {
      // Invite errors stay inline in the dialog (404 email not registered / 409
      // already a member) so the admin can correct the email without retyping.
      setInviteError(
        err instanceof ApiException
          ? err.message
          : t('studio.container.members.inviteFailed'),
      );
    },
  });

  const roleMutation = useMutation({
    mutationFn: (input: { userId: string; role: GrantableStudioRole }) =>
      studiosApi.updateMemberRole(slug, input.userId, { role: input.role }),
    onSuccess: async () => {
      await invalidateMembers();
      toast.success(t('studio.container.members.roleUpdated'));
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => studiosApi.removeMember(slug, userId),
    onSuccess: async () => {
      await invalidateMembers();
      setConfirm(null);
      toast.success(t('studio.container.members.removeSuccess'));
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });

  const transferMutation = useMutation({
    mutationFn: (userId: string) =>
      studiosApi.requestTransfer(slug, { toUserId: userId }),
    onSuccess: () => {
      // No member-list change yet — the swap happens when the recipient
      // confirms. Just acknowledge the request was sent.
      setConfirm(null);
      toast.success(t('studio.container.members.transferRequested'));
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });

  // A single row's pending flag (disables its menu) — true while a mutation
  // targeting that user is in flight.
  const pendingUserId =
    (roleMutation.isPending && roleMutation.variables?.userId) ||
    (removeMutation.isPending && removeMutation.variables) ||
    (transferMutation.isPending && transferMutation.variables) ||
    null;

  /**
   * Open the invite dialog with a clean inline-error slate.
   */
  const openInvite = (): void => {
    setInviteError(null);
    setInviteOpen(true);
  };

  return (
    <div className='mx-auto flex max-w-3xl flex-col gap-4'>
      {canManage ? (
        <div>
          <Button type='button' onClick={openInvite}>
            {t('studio.container.members.invite')}
          </Button>
        </div>
      ) : studioType === 'personal' ? (
        <p className='text-xs text-muted-foreground'>
          {t('studio.container.members.cannotInvitePersonal')}
        </p>
      ) : null}
      <table className='w-full text-left text-sm'>
        <thead className='text-xs text-muted-foreground'>
          <tr>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colName')}
            </th>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colJoined')}
            </th>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colRole')}
            </th>
            {canManage ? (
              <th className='pb-2'>
                <span className='sr-only'>
                  {t('studio.container.members.colActions')}
                </span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const admin = member.studioRole === 'admin';
            return (
              <tr
                key={member.id}
                className='border-t border-border first:border-t-0'
              >
                {/* Member: avatar + name over email (locked mock .mrow .who). */}
                <td className='py-2.5'>
                  <span className='flex items-center gap-3'>
                    <span
                      aria-hidden='true'
                      className='flex h-8 w-8 items-center justify-center rounded-full bg-[var(--neutral-200)] text-[13px] font-bold text-[var(--neutral-600)]'
                    >
                      {member.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className='flex min-w-0 flex-col'>
                      <span className='truncate font-semibold text-foreground'>
                        {member.name}
                      </span>
                      <span className='truncate text-xs text-muted-foreground'>
                        {member.email}
                      </span>
                    </span>
                  </span>
                </td>
                <td className='py-2.5 font-mono text-xs text-muted-foreground'>
                  {member.joinedAt.slice(0, 10)}
                </td>
                <td className='py-2.5'>
                  <span
                    className={`inline-flex h-5 min-w-[64px] items-center justify-center rounded-content-sm border border-border bg-background px-2 text-[11px] font-semibold ${
                      admin ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {roleLabel(member.studioRole, t)}
                  </span>
                </td>
                {canManage ? (
                  <td className='py-2.5 text-right'>
                    {/* The admin manages others, not themselves — no self-row menu. */}
                    {admin ? null : (
                      <MemberRowMenu
                        member={member}
                        pending={pendingUserId === member.id}
                        onToggleRole={(m) =>
                          roleMutation.mutate({
                            userId: m.id,
                            role:
                              m.studioRole === 'creator' ? 'member' : 'creator',
                          })
                        }
                        onRemove={(m) =>
                          setConfirm({ kind: 'remove', member: m })
                        }
                        onTransferAdmin={(m) =>
                          setConfirm({ kind: 'transfer', member: m })
                        }
                      />
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={(next) => {
          setInviteOpen(next);
          if (!next) setInviteError(null);
        }}
        onInvite={(values) => inviteMutation.mutate(values)}
        pending={inviteMutation.isPending}
        error={inviteError}
      />

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
      >
        <AlertDialogContent data-testid='member-confirm-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === 'transfer'
                ? t('studio.container.members.transferConfirmTitle')
                : t('studio.container.members.removeConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === 'transfer'
                ? t('studio.container.members.transferConfirmBody', {
                  name: confirm.member.name,
                })
                : confirm
                  ? t('studio.container.members.removeConfirmBody', {
                    name: confirm.member.name,
                  })
                  : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('studio.container.dialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.kind === 'remove' ? 'destructive' : 'default'}
              disabled={removeMutation.isPending || transferMutation.isPending}
              onClick={(event) => {
                // Keep the dialog mounted until the mutation's onSuccess closes
                // it, so a failure leaves it open with the toast error.
                event.preventDefault();
                if (confirm?.kind === 'remove') {
                  removeMutation.mutate(confirm.member.id);
                } else if (confirm?.kind === 'transfer') {
                  transferMutation.mutate(confirm.member.id);
                }
              }}
              data-testid='member-confirm-action'
            >
              {confirm?.kind === 'transfer'
                ? t('studio.container.members.transferConfirmAction')
                : t('studio.container.members.removeConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Maps a studio role to its localized table-cell label.
 * @param role the member's studio role.
 * @param t the translation function.
 * @returns the localized role label.
 */
function roleLabel(
  role: StudioRole,
  t: ReturnType<typeof useTranslation>,
): string {
  switch (role) {
    case 'admin':
      return t('studio.container.members.roleAdmin');
    case 'creator':
      return t('studio.container.members.roleCreator');
    default:
      return t('studio.container.members.roleMember');
  }
}

/**
 * Extracts a user-facing message from a mutation error — the server's localized
 * message when it is an `ApiException`, else a generic fallback.
 * @param err the caught mutation error.
 * @param t the translation function.
 * @returns the message to show in a toast.
 */
function errorMessage(
  err: unknown,
  t: ReturnType<typeof useTranslation>,
): string {
  return err instanceof ApiException
    ? err.message
    : t('studio.container.members.actionFailed');
}
