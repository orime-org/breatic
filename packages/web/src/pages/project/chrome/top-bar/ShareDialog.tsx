// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Send, UserPlus } from 'lucide-react';
import * as React from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@web/lib/toast';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Badge } from '@web/components/ui/badge';
import { Separator } from '@web/components/ui/separator';
import { ScrollArea } from '@web/components/ui/scroll-area';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { projectInvitationsApi } from '@web/data/api/project-invitations';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { useTranslation } from '@web/i18n/use-translation';
import { looksLikeEmail } from '@web/lib/looks-like-email';
import type { InvitableProjectRole, PendingProjectInvitationSummary } from '@breatic/shared';
import { StudioAvatar } from '@web/ui/StudioAvatar';

interface ShareDialogProps {
  projectId: string;
}

/**
 * Project invitation popover. Registered accounts receive a notification;
 * unregistered recipients receive a registration email and claim the invitation
 * after verifying that address. The Owner can inspect and revoke live pending
 * invitations. Membership starts when the recipient confirms.
 * @param root0 - Share dialog props.
 * @param root0.projectId - Id of the project being shared; the invite call targets it.
 * @returns the share trigger button and its email-only invite popover.
 */
export function ShareDialog({
  projectId,
}: ShareDialogProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const open = useUIStore((s) => s.shareOpen);
  const setOpen = useUIStore((s) => s.setShareOpen);
  const isOwner = useCurrentUserStore((s) => s.role === 'owner');
  const invitationsKey = React.useMemo(() => ['project', projectId, 'invitations'], [projectId]);
  const invitations = useQuery({
    queryKey: invitationsKey,
    queryFn: () => projectInvitationsApi.listPending(projectId),
    enabled: open && isOwner,
  });
  const revokeKey = React.useMemo(() => ['project', projectId, 'revoke-invitation'], [projectId]);
  const revokeMutation = useMutation({
    mutationKey: revokeKey,
    mutationFn: (invitationId: string) => projectInvitationsApi.revoke(projectId, invitationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: invitationsKey });
      toast.success(t('share.revokeSuccess'));
    },
    onError: (err) => toast.error(err instanceof ApiException ? err.message : t('share.revokeFailed')),
  });
  const revokingIds = useMutationState({
    filters: { mutationKey: revokeKey, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });
  const { mutate: revoke } = revokeMutation;
  const { refetch } = invitations;

  /** Re-read the Owner's pending invitations after a loading failure. */
  const retryInvitations = React.useCallback((): void => {
    void refetch();
  }, [refetch]);

  const [invite, setInvite] = React.useState('');
  const [inviteRole, setInviteRole] =
    React.useState<InvitableProjectRole>('viewer');
  const [inviteSubmitting, setInviteSubmitting] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  // Reset the transient invite state every time the popover opens, so reopening
  // never shows an email / error left over from a prior session. The role keeps
  // its last value — it is a harmless preference.
  React.useEffect(() => {
    if (!open) return;
    setInvite('');
    setInviteError(null);
  }, [open]);

  /**
   * Validates the address and creates a pending project invite, surfacing
   * errors inline and keeping the popover open on failure. Success refreshes
   * the pending list, reports the delivery path and closes the popover.
   * @returns once the invite has been created (or the error surfaced inline).
   */
  async function handleSendInvite(): Promise<void> {
    if (inviteSubmitting) return;
    const trimmed = invite.trim();
    if (!looksLikeEmail(trimmed)) {
      setInviteError(t('share.invalidEmail'));
      return;
    }
    setInviteError(null);
    setInviteSubmitting(true);
    try {
      const result = await projectInvitationsApi.inviteMember(projectId, {
        email: trimmed,
        role: inviteRole,
      });
      await queryClient.invalidateQueries({ queryKey: invitationsKey });
      toast.success(result?.pendingSignup
        ? t('share.inviteSentPendingSignup', { email: trimmed })
        : t('share.inviteSent'));
      setOpen(false);
    } catch (err) {
      const msg =
        err instanceof ApiException ? err.message : t('share.inviteFailed');
      setInviteError(msg);
    } finally {
      setInviteSubmitting(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label={t('chrome.tooltip.share')}
        >
          <UserPlus className='h-[18px] w-[18px]' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-max min-w-80 max-w-[calc(100vw-1rem)] p-1'
        data-testid='share-popover'
      >
        <SectionTitle>{t('share.inviteSection')}</SectionTitle>
        <div className='flex items-center gap-2 px-2 pb-2'>
          <Input
            type='email'
            autoComplete='email'
            value={invite}
            onChange={(e) => {
              setInvite(e.target.value);
              if (inviteError) setInviteError(null);
            }}
            placeholder={t('share.invitePlaceholder')}
            className='h-8 flex-1 text-sm'
            data-testid='share-invite-input'
            disabled={inviteSubmitting}
            aria-invalid={!!inviteError || undefined}
          />
          <RoleSelect
            value={inviteRole}
            onChange={setInviteRole}
            disabled={inviteSubmitting}
            testId='share-invite-role'
          />
        </div>
        {inviteError ? (
          <p
            className='px-2 pb-1 text-xs text-status-error-foreground'
            role='alert'
          >
            {inviteError}
          </p>
        ) : null}
        <div className='px-2 pb-2'>
          <Button
            size='form'
            className='w-full'
            disabled={invite.trim().length === 0 || inviteSubmitting}
            loading={inviteSubmitting}
            icon={<Send className='h-4 w-4' />}
            onClick={handleSendInvite}
            data-testid='share-send-invite'
          >
            {inviteSubmitting
              ? t('share.inviteSending')
              : t('share.inviteButton')}
          </Button>
        </div>
        {isOwner && invitations.isPending ? (
          <p className='px-2 pb-2 text-xs text-muted-foreground'>{t('common.loading')}</p>
        ) : null}
        {isOwner && invitations.isError ? (
          <div className='flex items-center gap-2 px-2 pb-2'>
            <p role='alert' className='text-xs text-status-error-foreground'>
              {invitations.error instanceof ApiException
                ? invitations.error.message
                : t('common.pageUnavailable.message')}
            </p>
            <Button variant='outline' size='sm' loading={invitations.isFetching} onClick={retryInvitations}>
              {t('common.pageUnavailable.action')}
            </Button>
          </div>
        ) : null}
        {isOwner && invitations.data && invitations.data.length > 0 ? (
          <>
            <Separator />
            <SectionTitle>{t('share.pendingTitle')}</SectionTitle>
            <ScrollArea viewportClassName='max-h-80'>
              <ul>
                {invitations.data.map((invitation) => (
                  <ProjectInvitationRow
                    key={invitation.invitationId}
                    invitation={invitation}
                    revoking={revokingIds.includes(invitation.invitationId)}
                    onRevoke={revoke}
                  />
                ))}
              </ul>
            </ScrollArea>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** A pending recipient and the revoke action tied to that invitation. */
interface ProjectInvitationRowProps {
  invitation: PendingProjectInvitationSummary;
  revoking: boolean;
  onRevoke: (invitationId: string) => void;
}

/**
 * Display a pending invitation using its recipient's current identity.
 * @param props - The pending invitation and its revoke action.
 * @param props.invitation - The server's pending-recipient summary.
 * @param props.revoking - Whether this invitation's revoke is waiting.
 * @param props.onRevoke - Revoke the specified invitation.
 * @returns The recipient row, status label and independent revoke button.
 */
const ProjectInvitationRow = React.memo(function ProjectInvitationRow({
  invitation,
  revoking,
  onRevoke,
}: ProjectInvitationRowProps): React.JSX.Element {
  const t = useTranslation();
  const name = invitation.awaitingSignup ? invitation.email : invitation.name;
  const role = invitation.role === 'editor' ? t('share.role.edit') : t('share.role.view');
  /** Revoke the invitation displayed by this row. */
  const handleRevoke = React.useCallback((): void => {
    onRevoke(invitation.invitationId);
  }, [onRevoke, invitation.invitationId]);
  return (
    <li className='flex items-center gap-2 px-2 py-2' data-testid={`share-invitation-${invitation.invitationId}`}>
      <StudioAvatar name={name} type='personal' avatarUrl={invitation.avatarUrl} size='sm' />
      <div className='min-w-0 max-w-48 flex-1'>
        <div className='truncate text-sm font-semibold'>{name}</div>
        {invitation.awaitingSignup ? null : (
          <div className='truncate text-xs text-muted-foreground'>{invitation.email}</div>
        )}
      </div>
      <Badge variant='outline' className='shrink-0 whitespace-nowrap rounded-content-sm border-border bg-background text-2xs text-muted-foreground'>
        {invitation.awaitingSignup ? (
          <>{role}{' · '}<span>{t('share.awaitingSignup')}</span></>
        ) : t('share.pendingBadge', { role })}
      </Badge>
      <Button variant='outline' size='sm' loading={revoking} onClick={handleRevoke}>
        {t('share.revoke')}
      </Button>
    </li>
  );
});

/**
 * Uppercase section heading for the invite flow.
 * @param root0 - Section title props.
 * @param root0.children - Heading text to render.
 * @returns the styled section heading.
 */
function SectionTitle({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className='px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground'>
      {children}
    </div>
  );
}

interface RoleSelectProps {
  value: InvitableProjectRole;
  onChange: (next: InvitableProjectRole) => void;
  disabled?: boolean;
  testId: string;
}

/**
 * Role picker (viewer/editor) for the invite flow.
 * @param root0 - Role select props.
 * @param root0.value - Currently selected grantable role.
 * @param root0.onChange - Called with the new role when the selection changes.
 * @param root0.disabled - Whether the select is disabled.
 * @param root0.testId - Test id applied to the select trigger.
 * @returns the viewer/editor role select control.
 */
function RoleSelect({
  value,
  onChange,
  disabled,
  testId,
}: RoleSelectProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as InvitableProjectRole)}
      disabled={disabled}
    >
      <SelectTrigger className='h-8 w-[88px] text-xs' data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value='viewer'>{t('share.role.view')}</SelectItem>
        <SelectItem value='editor'>{t('share.role.edit')}</SelectItem>
      </SelectContent>
    </Select>
  );
}
