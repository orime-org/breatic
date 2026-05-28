import { Copy, Send, Share2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
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

interface ShareDialogProps {
  projectId: string;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function inviteUrlFor(token: string): string {
  // Anchor on the current origin so dev/staging environments produce
  // links that point back to themselves; SSR / no-window contexts
  // fall back to the canonical production host.
  if (typeof window !== 'undefined' && window.location.origin) {
    return `${window.location.origin}/invite/${token}`;
  }
  return `https://breatic.ai/invite/${token}`;
}

/**
 * Share popover — invite by email + sharable link (single-use vs
 * permanent toggle). Renders as a `Popover` (not a modal dialog) per
 * mock `.menu-popover.anchor-share.large`.
 *
 * Two independent flows:
 *
 *   1. Invite by email: typing an email + clicking Send dispatches
 *      a permanent invite link to that address via
 *      `inviteLinksApi.create({ invitee_email })`. The server sends
 *      `shareInvite` mail; the popover closes the input and toasts
 *      success.
 *
 *   2. Sharable link: a permanent toggle controls whether the next
 *      "Generate link" creates a permanent or single-use link. The
 *      generated URL is displayed with a copy button. The toggle
 *      itself doesn't auto-create — it only sets the mode for the
 *      next generate so the user can stage their choice before
 *      committing.
 *
 * Invite address is email-only (per user 2026-05-28 decision):
 * usernames are mutable and can't serve as a stable invite
 * identifier. Placeholder + zod-style regex validation enforces this.
 */
export function ShareDialog({ projectId }: ShareDialogProps) {
  const t = useTranslation();
  const open = useUIStore((s) => s.shareOpen);
  const setOpen = useUIStore((s) => s.setShareOpen);

  const [invite, setInvite] = React.useState('');
  const [inviteSubmitting, setInviteSubmitting] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);

  const [permanent, setPermanent] = React.useState(false);
  const [generatedLink, setGeneratedLink] = React.useState<InviteLink | null>(
    null,
  );
  const [generating, setGenerating] = React.useState(false);

  const [copied, setCopied] = React.useState(false);

  const inviteUrl = generatedLink ? inviteUrlFor(generatedLink.token) : '';

  const copy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may be unavailable in some contexts — fall back
      // to a manual selection prompt via toast.
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
        invitee_email: trimmed,
        role: 'view',
        is_permanent: true,
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

  async function handleGenerateLink() {
    if (generating) return;
    setGenerating(true);
    try {
      const res = await inviteLinksApi.create(projectId, {
        role: 'view',
        is_permanent: permanent,
      });
      setGeneratedLink(res.data);
    } catch (err) {
      const msg =
        err instanceof ApiException ? err.message : t('share.generateFailed');
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }

  return (
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
            disabled={inviteSubmitting}
            aria-invalid={!!inviteError || undefined}
          />
        </div>
        {inviteError ? (
          <p
            className='px-2 pb-1 text-xs text-destructive'
            role='alert'
          >
            {inviteError}
          </p>
        ) : null}
        <div className='px-2 pb-2'>
          <Button
            size='sm'
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

        <Separator className='my-1' />

        <SectionTitle>{t('share.linkSection')}</SectionTitle>
        <div className='flex items-center gap-2 px-2 pb-2'>
          <Input
            readOnly
            value={inviteUrl}
            placeholder={t('share.linkPlaceholder')}
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
        <div className='flex items-center justify-between gap-2 px-2 py-2'>
          <span className='text-[13px] text-foreground'>
            {t('share.linkPermanent')}
          </span>
          <button
            type='button'
            role='switch'
            aria-checked={permanent}
            onClick={() => setPermanent((v) => !v)}
            data-testid='share-permanent-toggle'
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              permanent ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'inline-block h-4 w-4 rounded-full bg-popover shadow transition-transform',
                permanent ? 'translate-x-[18px]' : 'translate-x-0.5',
              )}
            />
          </button>
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
              : permanent
                ? t('share.linkGeneratePermanent')
                : t('share.linkGenerateSingleUse')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className='px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
      {children}
    </div>
  );
}
