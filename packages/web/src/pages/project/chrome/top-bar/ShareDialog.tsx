import { Copy, Send, Share2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  inviteLinksApi,
  type InviteLink,
} from '@/data/api/invite-links';
import { ApiException } from '@/data/api/types';
import { useUIStore } from '@/stores';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n/use-translation';
import { ShareLinksListDialog } from '@/pages/project/chrome/top-bar/ShareLinksListDialog';

interface ShareDialogProps {
  projectId: string;
  /**
   * Whether the SMTP backend is configured. When `false`, the "Invite
   * by email" section is disabled and the user sees a hint to use
   * Generate link instead. Defaults to `true` (we surface SMTP
   * disconnection from outside via the `useEmailEnabled` hook in
   * Phase 9 — for now, callers can omit this prop and the section
   * stays enabled).
   */
  emailEnabled?: boolean;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type GrantableRole = 'view' | 'edit';

function inviteUrlFor(token: string): string {
  if (typeof window !== 'undefined' && window.location.origin) {
    return `${window.location.origin}/invite/${token}`;
  }
  return `https://breatic.ai/invite/${token}`;
}

/**
 * Share popover — two independent flows per spec § 4 (2026-05-28):
 *
 *   1. Invite by email — single-use, bound to recipient, 7-day TTL.
 *      Owner types the address + picks a role; clicking Invite asks
 *      the server to create the link AND dispatch the share-invite
 *      mail. The popover input clears + toasts success when the
 *      server returns 201.
 *
 *   2. Generate link — multi-use, unbound, no expiry. Owner picks the
 *      default role + clicks Generate; the resulting URL is shown
 *      with a copy button. The link stays valid until the owner
 *      revokes it from the ShareLinksListDialog.
 *
 * Below the two sections, a "View all generated links (N)" entry
 * opens a sibling dialog (ShareLinksListDialog) showing every
 * non-revoked link on the project, with per-row Copy + Revoke. N is
 * the count returned by `inviteLinksApi.listByProject`.
 *
 * Invite address is email-only (per user 2026-05-28 decision):
 * usernames are mutable and can't serve as a stable invite identifier.
 */
export function ShareDialog({ projectId, emailEnabled = true }: ShareDialogProps) {
  const t = useTranslation();
  const open = useUIStore((s) => s.shareOpen);
  const setOpen = useUIStore((s) => s.setShareOpen);

  const [invite, setInvite] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<GrantableRole>('view');
  const [inviteSubmitting, setInviteSubmitting] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);

  const [generateRole, setGenerateRole] = React.useState<GrantableRole>('view');
  const [generatedLink, setGeneratedLink] = React.useState<InviteLink | null>(
    null,
  );
  const [generating, setGenerating] = React.useState(false);

  const [copied, setCopied] = React.useState(false);
  const [listDialogOpen, setListDialogOpen] = React.useState(false);

  // Count of active links on this project. Drives the "View all (N)"
  // entry copy. Queries lazily — only when the popover opens — so
  // mounting BellMenu / ShareDialog inside a hot canvas doesn't fire
  // the network on every render.
  const linksQuery = useQuery({
    queryKey: ['invite-links', projectId],
    queryFn: () => inviteLinksApi.listByProject(projectId),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const linkCount = (linksQuery.data?.data ?? []).length;

  const inviteUrl = generatedLink ? inviteUrlFor(generatedLink.token) : '';

  const copy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast(t('share.copyFallback'));
    }
  };

  async function handleSendInvite() {
    if (inviteSubmitting) return;
    const trimmed = invite.trim();
    if (!EMAIL_RX.test(trimmed)) {
      setInviteError(t('share.invalidEmail'));
      return;
    }
    setInviteError(null);
    setInviteSubmitting(true);
    try {
      await inviteLinksApi.create(projectId, {
        kind: 'email',
        invitee_email: trimmed,
        role: inviteRole,
      });
      toast.success(t('share.inviteSent'));
      setInvite('');
      linksQuery.refetch();
    } catch (err) {
      const msg =
        err instanceof ApiException ? err.message : t('share.inviteFailed');
      setInviteError(msg);
    } finally {
      setInviteSubmitting(false);
    }
  }

  async function handleGenerateLink() {
    if (generating) return;
    setGenerating(true);
    try {
      const res = await inviteLinksApi.create(projectId, {
        kind: 'link',
        role: generateRole,
      });
      setGeneratedLink(res.data);
      linksQuery.refetch();
    } catch (err) {
      const msg =
        err instanceof ApiException ? err.message : t('share.generateFailed');
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant='chrome-ghost' size='chrome' aria-label='Share'>
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
          {!emailEnabled ? (
            <p
              className='px-2 pb-2 text-[12px] text-muted-foreground'
              data-testid='share-email-disabled-hint'
            >
              {t('share.emailDisabledHint')}
            </p>
          ) : null}
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
              className='h-8 flex-1 text-[13px]'
              data-testid='share-invite-input'
              disabled={!emailEnabled || inviteSubmitting}
              aria-invalid={!!inviteError || undefined}
            />
            <RoleSelect
              value={inviteRole}
              onChange={setInviteRole}
              disabled={!emailEnabled || inviteSubmitting}
              testId='share-invite-role'
            />
          </div>
          {inviteError ? (
            <p className='px-2 pb-1 text-xs text-destructive' role='alert'>
              {inviteError}
            </p>
          ) : null}
          <div className='px-2 pb-2'>
            <Button
              size='sm'
              className='w-full'
              disabled={
                !emailEnabled ||
                invite.trim().length === 0 ||
                inviteSubmitting
              }
              onClick={handleSendInvite}
              data-testid='share-send-invite'
            >
              <Send className='h-4 w-4' />
              {inviteSubmitting
                ? t('share.inviteSending')
                : t('share.inviteButton')}
            </Button>
          </div>

          <Separator className='my-1' />

          <SectionTitle>{t('share.linkSection')}</SectionTitle>
          <div className='flex items-center justify-between gap-2 px-2 pb-2'>
            <span className='text-[12px] text-muted-foreground'>
              {t('share.linkDefaultRole')}
            </span>
            <RoleSelect
              value={generateRole}
              onChange={setGenerateRole}
              disabled={generating}
              testId='share-generate-role'
            />
          </div>
          <div className='px-2 pb-2'>
            <Button
              size='sm'
              variant='outline'
              className='w-full'
              onClick={handleGenerateLink}
              disabled={generating}
              data-testid='share-generate-link'
            >
              {generating
                ? t('share.linkGenerating')
                : t('share.linkGenerate')}
            </Button>
          </div>
          {generatedLink ? (
            <div className='flex items-center gap-2 px-2 pb-2'>
              <Input
                readOnly
                value={inviteUrl}
                className='h-8 flex-1 text-[13px]'
                data-testid='share-invite-url'
              />
              <Button
                variant='chrome-ghost'
                size='chrome'
                onClick={copy}
                disabled={!inviteUrl}
                aria-label={copied ? 'Copied' : 'Copy link'}
                data-testid='share-copy-link'
              >
                <Copy className='h-[16px] w-[16px]' />
              </Button>
            </div>
          ) : null}

          <Separator className='my-1' />

          <div className='px-2 py-2'>
            <button
              type='button'
              className='w-full text-left text-[12px] text-primary underline-offset-2 hover:underline'
              onClick={() => setListDialogOpen(true)}
              data-testid='share-view-all-links'
            >
              {t('share.viewAllLinks', { count: linkCount })}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <ShareLinksListDialog
        projectId={projectId}
        open={listDialogOpen}
        onOpenChange={setListDialogOpen}
      />
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className='px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
      {children}
    </div>
  );
}

interface RoleSelectProps {
  value: GrantableRole;
  onChange: (next: GrantableRole) => void;
  disabled?: boolean;
  testId: string;
}

function RoleSelect({ value, onChange, disabled, testId }: RoleSelectProps) {
  const t = useTranslation();
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as GrantableRole)}
      disabled={disabled}
    >
      <SelectTrigger
        className='h-8 w-[88px] text-[12px]'
        data-testid={testId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value='view'>{t('share.role.view')}</SelectItem>
        <SelectItem value='edit'>{t('share.role.edit')}</SelectItem>
      </SelectContent>
    </Select>
  );
}
