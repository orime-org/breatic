// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Send, Share2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
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
import { useUIStore } from '@web/stores';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import type { InvitableProjectRole } from '@breatic/shared';

interface ShareDialogProps {
  projectId: string;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Share popover — invite-by-email only (project invite-confirm handshake,
 * 2026-06-18, #1337). The owner types a registered user's email + picks a role
 * (`editor` / `viewer`); clicking Invite asks the server to create a PENDING
 * project invite, which drops an actionable bell notification in the invitee's
 * inbox (and best-effort an email link to the `/project-invite` landing page).
 * The invitee becomes a member only after they confirm — no immediate access,
 * no public/copy link (the old `share_links` public-link mode was removed so
 * every project invite goes through the same confirm handshake as studio).
 *
 * Invite address is email-only: usernames are mutable and can't serve as a
 * stable invite identifier, and only already-registered users can be invited.
 * @param root0 - Share dialog props.
 * @param root0.projectId - Id of the project being shared; the invite call targets it.
 * @returns the share trigger button and its email-only invite popover.
 */
export function ShareDialog({
  projectId,
}: ShareDialogProps): React.JSX.Element {
  const t = useTranslation();
  const open = useUIStore((s) => s.shareOpen);
  const setOpen = useUIStore((s) => s.setShareOpen);

  const [invite, setInvite] = React.useState('');
  const [inviteRole, setInviteRole] =
    React.useState<InvitableProjectRole>('viewer');
  const [inviteSubmitting, setInviteSubmitting] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);

  /**
   * Validates the address and creates a pending project invite, surfacing
   * errors inline. On success the input clears and a toast confirms the invite
   * was sent (the invitee gets a bell notification + best-effort email).
   * @returns once the invite has been created (or the error surfaced inline).
   */
  async function handleSendInvite(): Promise<void> {
    if (inviteSubmitting) return;
    const trimmed = invite.trim();
    if (!EMAIL_RX.test(trimmed)) {
      setInviteError(t('share.invalidEmail'));
      return;
    }
    setInviteError(null);
    setInviteSubmitting(true);
    try {
      await projectInvitationsApi.inviteMember(projectId, {
        email: trimmed,
        role: inviteRole,
      });
      toast.success(t('share.inviteSent'));
      setInvite('');
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
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant='chrome-ghost'
              size='chrome'
              aria-label={t('chrome.tooltip.share')}
            >
              <Share2 className='h-[18px] w-[18px]' />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side='bottom'>{t('chrome.tooltip.share')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align='end'
        className='w-80 p-1'
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
            onClick={handleSendInvite}
            data-testid='share-send-invite'
          >
            <Send className='h-4 w-4' />
            {inviteSubmitting
              ? t('share.inviteSending')
              : t('share.inviteButton')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
