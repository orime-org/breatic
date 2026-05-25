import { Copy, Send, Share2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores';
import { useTranslation } from '@/i18n/use-translation';

interface ShareDialogProps {
  projectId: string;
}

/**
 * Share popover — invite + public link toggle. Renders as a `Popover` (not
 * a modal dialog) per mock `.menu-popover.anchor-share.large`. Real invite
 * token generation + public toggle persistence land with the
 * project-members API wiring in a later PR; this PR ships the chrome.
 *
 * Layout follows mock:
 *   - "Invite collaborators" section (title + invite input row + send button)
 *   - separator
 *   - "Share link" section (title + URL row + copy button + public toggle row)
 */
export function ShareDialog({ projectId }: ShareDialogProps) {
  const t = useTranslation();
  const inviteUrl = `https://breatic.ai/invite/${projectId}`;
  const open = useUIStore((s) => s.shareOpen);
  const setOpen = useUIStore((s) => s.setShareOpen);
  const [invite, setInvite] = React.useState('');
  const [publicLink, setPublicLink] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may be unavailable in some contexts — ignore silently.
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant='chrome-ghost' size='chrome' aria-label='Share'>
          <Share2 className='h-[18px] w-[18px]' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-80 p-1'
        data-testid='share-popover'
      >
        <SectionTitle>{t('share.inviteSection')}</SectionTitle>
        <div className='flex items-center gap-2 px-2 pb-2'>
          <Input
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder={t('share.invitePlaceholder')}
            className='h-8 flex-1 text-[13px]'
            data-testid='share-invite-input'
          />
        </div>
        <div className='px-2 pb-2'>
          <Button
            // outline variant matches the "邀请新成员" button in
            // MembersStack popover (2026-05-25 user ask:发送邀请
            // should share visual language with the members popover
            // invite CTA — both are "open invite intent" buttons
            // inside a chrome popover, neither warrants prominent
            // primary solid bg).
            variant='outline'
            size='sm'
            className='w-full justify-center gap-2 text-[13px]'
            disabled={invite.trim().length === 0}
            data-testid='share-send-invite'
          >
            <Send className='h-4 w-4' />
            {t('share.inviteButton')}
          </Button>
        </div>

        <Separator className='my-1' />

        <SectionTitle>{t('share.linkSection')}</SectionTitle>
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
            aria-label={copied ? 'Copied' : 'Copy link'}
            data-testid='share-copy-link'
          >
            <Copy className='h-[16px] w-[16px]' />
          </Button>
        </div>
        <div className='flex items-center justify-between gap-2 px-2 py-2'>
          <span className='text-[13px] text-foreground'>
            {t('share.linkAccess')}
          </span>
          <button
            type='button'
            role='switch'
            aria-checked={publicLink}
            onClick={() => setPublicLink((v) => !v)}
            data-testid='share-public-toggle'
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              publicLink ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'inline-block h-4 w-4 rounded-full bg-popover shadow transition-transform',
                publicLink ? 'translate-x-[18px]' : 'translate-x-0.5',
              )}
            />
          </button>
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
