import { Copy, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Button } from '@web/components/ui/button';
import {
  inviteLinksApi,
  type InviteLink,
} from '@web/data/api/invite-links';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';

interface ShareLinksListDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function inviteUrlFor(token: string): string {
  if (typeof window !== 'undefined' && window.location.origin) {
    return `${window.location.origin}/invite/${token}`;
  }
  return `https://breatic.ai/invite/${token}`;
}

function shortenToken(token: string): string {
  // 6-3 split: first 6 chars + "…" + last 3 — owners scan many tokens
  // at once, this keeps each row's tail recognisable.
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-3)}`;
}

function relativeTime(iso: string, t: ReturnType<typeof useTranslation>): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60_000));
  if (minutes < 1) return t('share.relativeTime.justNow');
  if (minutes < 60) return t('share.relativeTime.minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('share.relativeTime.hours', { n: hours });
  const days = Math.round(hours / 24);
  return t('share.relativeTime.days', { n: days });
}

/**
 * Full list of active (non-revoked) invite links on the current project.
 *
 * Owner opens this from "View all generated links (N)" in ShareDialog
 * to see every link still in circulation + copy / revoke them
 * individually. Each row shows:
 *   - shortened token (clickable to copy the full URL)
 *   - granted role (view / edit) badge
 *   - relative creation time
 *   - email-invite badge (when kind === 'email')
 *   - Copy + Revoke per-row actions
 *
 * Revoke calls `inviteLinksApi.revoke`, which soft-deletes on the
 * server; the React Query cache is invalidated so the row disappears.
 *
 * Spec: access-permission design (2026-05-28) § 4.3.
 */
export function ShareLinksListDialog({
  projectId,
  open,
  onOpenChange,
}: ShareLinksListDialogProps) {
  const t = useTranslation();
  const queryClient = useQueryClient();

  const linksQuery = useQuery({
    queryKey: ['invite-links', projectId],
    queryFn: () => inviteLinksApi.listByProject(projectId),
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const revokeMutation = useMutation({
    mutationFn: (linkId: string) => inviteLinksApi.revoke(projectId, linkId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['invite-links', projectId],
      });
      toast.success(t('share.linksList.revokeSuccess'));
    },
    onError: (err) => {
      const msg =
        err instanceof ApiException ? err.message : t('share.linksList.revokeFailed');
      toast.error(msg);
    },
  });

  const links = linksQuery.data?.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='max-w-lg'
        data-testid='share-links-list-dialog'
      >
        <DialogHeader>
          <DialogTitle>{t('share.linksList.title')}</DialogTitle>
          <DialogDescription>
            {t('share.linksList.description')}
          </DialogDescription>
        </DialogHeader>
        {linksQuery.isLoading ? (
          <div className='py-6 text-center text-[13px] text-muted-foreground'>
            {t('common.loading')}
          </div>
        ) : links.length === 0 ? (
          <div
            className='py-6 text-center text-[13px] text-muted-foreground'
            data-testid='share-links-list-empty'
          >
            {t('share.linksList.empty')}
          </div>
        ) : (
          <ul className='max-h-[60vh] overflow-y-auto'>
            {links.map((link) => (
              <li
                key={link.id}
                data-testid={`share-links-list-row-${link.id}`}
                className='flex items-center gap-2 border-b border-border py-2 last:border-b-0'
              >
                <LinkRow
                  link={link}
                  onRevoke={() => revokeMutation.mutate(link.id)}
                  pending={
                    revokeMutation.isPending &&
                    revokeMutation.variables === link.id
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface LinkRowProps {
  link: InviteLink;
  onRevoke: () => void;
  pending: boolean;
}

function LinkRow({ link, onRevoke, pending }: LinkRowProps) {
  const t = useTranslation();
  const url = inviteUrlFor(link.token);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t('share.linksList.copied'));
    } catch {
      toast(t('share.copyFallback'));
    }
  };

  return (
    <div className='flex w-full items-center gap-3'>
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span
          className='truncate text-[13px] font-mono'
          title={link.token}
          data-testid={`share-links-list-token-${link.id}`}
        >
          {shortenToken(link.token)}
        </span>
        <span className='flex items-center gap-2 text-[11px] text-muted-foreground'>
          <RoleBadge role={link.role} />
          <span>·</span>
          <span>{relativeTime(link.createdAt, t)}</span>
          {link.kind === 'email' ? (
            <>
              <span>·</span>
              <span data-testid={`share-links-list-email-${link.id}`}>
                {t('share.linksList.emailBadge')}
              </span>
            </>
          ) : null}
        </span>
      </div>
      <Button
        variant='ghost'
        size='sm'
        onClick={copy}
        aria-label={t('share.linksList.copyAria')}
        data-testid={`share-links-list-copy-${link.id}`}
      >
        <Copy className='h-4 w-4' />
      </Button>
      <Button
        variant='ghost'
        size='sm'
        onClick={onRevoke}
        disabled={pending}
        aria-label={t('share.linksList.revokeAria')}
        data-testid={`share-links-list-revoke-${link.id}`}
      >
        <Trash2 className='h-4 w-4' />
      </Button>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const t = useTranslation();
  const label =
    role === 'edit'
      ? t('share.role.edit')
      : role === 'view'
        ? t('share.role.view')
        : role;
  return (
    <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground'>
      {label}
    </span>
  );
}
