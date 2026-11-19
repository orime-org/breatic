// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Agent tokens dialog's body (#1488 §5): the OAuth clients and the
 * personal access tokens connected to the user's account, each renamed,
 * disconnected or revoked here, and new tokens created here with their
 * plaintext shown once. A comment's hand-over label opens it pointing at one row.
 */

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, KeyRound, Pencil, Plus } from 'lucide-react';
import {
  AGENT_CONNECTION_NAME_MAX_LENGTH,
  PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS,
  type AgentConnectionItem,
  type PersonalAccessTokenExpiryDays,
} from '@breatic/shared';
import { AGENT_CONNECTIONS_KEY, agentAccessApi } from '@web/data/api/agent-access';
import { ApiException } from '@web/data/api/types';
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
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { formatLocalDay } from '@web/lib/format-day';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';

type Translate = ReturnType<typeof useTranslation>;

/** The token lifetimes offered, as the Select carries them; `never` is a token that does not expire. */
const EXPIRY_OPTIONS = [...PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS.map(String), 'never'] as const;
const DEFAULT_EXPIRY = '90';

/**
 * A select value back to the lifetime the server takes.
 * @param value - The select value.
 * @returns Days, or null for never.
 */
function expiryOf(value: string): PersonalAccessTokenExpiryDays {
  return value === 'never' ? null : (Number(value) as PersonalAccessTokenExpiryDays);
}

/**
 * The message a failed call shows: the server's own sentence when it wrote one.
 * @param err - What the call threw.
 * @param fallback - The section's own sentence.
 * @returns The message.
 */
function failureMessage(err: unknown, fallback: string): string {
  return err instanceof ApiException && err.fromServer && err.message !== '' ? err.message : fallback;
}

interface AgentsSectionProps {
  /** The connection a comment's label opened the page for. */
  focusId?: string;
  /** The page's scroller, to bring that connection into view. */
  scroller?: React.RefObject<HTMLDivElement | null>;
}

/**
 * The External Agents section.
 * @param props - The section's props.
 * @param props.focusId - The connection to point at.
 * @param props.scroller - The page's scroller.
 * @returns The section.
 */
export function AgentsSection({ focusId, scroller }: AgentsSectionProps): React.JSX.Element {
  const t = useTranslation();
  const query = useQuery({ queryKey: AGENT_CONNECTIONS_KEY, queryFn: agentAccessApi.listConnections });
  const rows = query.data;
  const clients = React.useMemo(() => (rows ?? []).filter((row) => row.kind !== 'pat'), [rows]);
  const tokens = React.useMemo(() => (rows ?? []).filter((row) => row.kind === 'pat'), [rows]);
  const onRetry = React.useCallback((): void => void query.refetch(), [query]);

  // Bring the row a label pointed at to the middle of the page, once it is drawn.
  const focusedRow = React.useRef<HTMLDivElement | null>(null);
  const loaded = rows !== undefined;
  React.useEffect(() => {
    const row = focusedRow.current;
    const viewport = scroller?.current;
    if (!loaded || !row || !viewport) return;
    const rowBox = row.getBoundingClientRect();
    const viewBox = viewport.getBoundingClientRect();
    const top = viewport.scrollTop + rowBox.top - viewBox.top - (viewport.clientHeight - rowBox.height) / 2;
    viewport.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [loaded, focusId, scroller]);

  /**
   * One list's body: its loading rows, failure, empty state or rows.
   * @param list - The rows.
   * @param empty - The empty state's sentence.
   * @param testId - The list's test id.
   * @returns The body.
   */
  const body = (list: AgentConnectionItem[], empty: string, testId: string): React.JSX.Element => {
    if (query.isPending) {
      return (
        <div className='flex flex-col gap-2 rounded-chrome border border-border p-3'>
          <Skeleton className='h-4 w-1/3' />
          <Skeleton className='h-3 w-2/3' />
        </div>
      );
    }
    if (query.isError) {
      return (
        <div className='flex items-center justify-between rounded-chrome border border-border px-3 py-2 text-xs text-muted-foreground'>
          <span>{t('agentTokens.loadFailed')}</span>
          <Button variant='outline' size='sm' onClick={onRetry}>{t('agentTokens.retry')}</Button>
        </div>
      );
    }
    if (list.length === 0) {
      return <p className='rounded-chrome border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground'>{empty}</p>;
    }
    return (
      <div className='rounded-chrome border border-border' data-testid={testId}>
        {list.map((row) => (
          <AgentRow key={row.id} row={row} focused={row.id === focusId} rowRef={row.id === focusId ? focusedRow : undefined} t={t} />
        ))}
      </div>
    );
  };

  return (
    <section className='flex flex-col gap-4'>
      <p className='text-xs text-muted-foreground'>{t('agentTokens.intro')}</p>
      <div className='flex flex-col gap-2'>
        <h4 className='text-sm font-semibold'>{t('agentTokens.clientsTitle')}</h4>
        {body(clients, t('agentTokens.clientsEmpty'), 'agents-clients')}
      </div>
      <div className='flex flex-col gap-2'>
        <div className='flex items-center justify-between gap-2'>
          <h4 className='text-sm font-semibold'>{t('agentTokens.tokensTitle')}</h4>
          <CreateTokenDialog t={t} />
        </div>
        {body(tokens, t('agentTokens.tokensEmpty'), 'agents-tokens')}
      </div>
    </section>
  );
}

interface AgentRowProps {
  row: AgentConnectionItem;
  focused: boolean;
  rowRef: React.RefObject<HTMLDivElement | null> | undefined;
  t: Translate;
}

/**
 * One connection: its name (renamed in place), what it is, and the button that ends it.
 * @param props - The row's props.
 * @param props.row - The connection.
 * @param props.focused - Whether a label pointed at it.
 * @param props.rowRef - Where the section finds it to scroll to.
 * @param props.t - Translate.
 * @returns The row.
 */
const AgentRow = React.memo(function AgentRow({ row, focused, rowRef, t }: AgentRowProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(row.displayName);
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const rename = useMutation({
    mutationFn: (name: string) => agentAccessApi.rename(row.id, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AGENT_CONNECTIONS_KEY });
      setEditing(false);
    },
    onError: (err) => toast.error(failureMessage(err, t('agentTokens.renameFailed'))),
  });
  const blank = draft.trim() === '';
  const onStartEdit = React.useCallback((): void => {
    setDraft(row.displayName);
    setEditing(true);
  }, [row.displayName]);
  const onCancel = React.useCallback((): void => setEditing(false), []);
  const { mutate: renameTo, isPending: saving } = rename;
  const onSave = React.useCallback((): void => {
    if (draft.trim() !== '') renameTo(draft.trim());
  }, [draft, renameTo]);
  const Icon = row.kind === 'pat' ? KeyRound : Bot;

  if (editing) {
    return (
      <div className='flex flex-col gap-1.5 border-b border-border px-3 py-2.5 last:border-b-0'>
        <div className='flex items-center gap-2'>
          <Icon className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
          <Input
            ref={input}
            aria-label={t('agentTokens.rename')}
            className='h-8 min-w-0 flex-1'
            value={draft}
            maxLength={AGENT_CONNECTION_NAME_MAX_LENGTH}
            autoComplete='off'
            disabled={saving}
            aria-invalid={blank}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSave();
              if (event.key === 'Escape' && !saving) onCancel();
            }}
          />
          <Button variant='outline' disabled={saving} onClick={onCancel}>{t('agentTokens.cancel')}</Button>
          <Button disabled={blank} loading={saving} onClick={onSave}>{t('agentTokens.save')}</Button>
        </div>
        <span className={cn('pl-6 text-xs', blank ? 'text-status-error-foreground' : 'text-muted-foreground')}>
          {blank ? t('agentTokens.nameRequired') : t('agentTokens.renameHint')}
        </span>
      </div>
    );
  }

  const expired = row.status === 'expired';
  const used = row.lastUsedAt === null ? t('agentTokens.neverUsed') : formatLocalDay(row.lastUsedAt);
  const since = formatLocalDay(row.createdAt);
  const meta =
    row.kind === 'pat'
      ? t('agentTokens.tokenMeta', {
        prefix: row.tokenPrefix ?? '',
        since,
        expires: row.expiresAt == null ? t('agentTokens.neverExpires') : formatLocalDay(row.expiresAt),
        used,
      })
      : t(expired && row.kind === 'cimd' ? 'agentTokens.clientMetaExpiredCimd' : 'agentTokens.clientMeta', {
        since,
        used,
        name: row.displayName,
      });
  return (
    <div
      ref={rowRef}
      data-testid={`agent-row-${row.id}`}
      data-focused={focused ? 'true' : undefined}
      className={cn('flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0', focused && 'bg-accent')}
    >
      <Icon className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
      <div className='flex min-w-0 flex-1 flex-col'>
        <span className='flex min-w-0 items-center gap-1'>
          <span className='truncate font-medium'>{row.displayName}</span>
          {expired ? <Badge variant='secondary'>{t('agentTokens.expired')}</Badge> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='ghost'
                size='icon'
                className='size-6'
                aria-label={`${t('agentTokens.rename')} ${row.displayName}`}
                onClick={onStartEdit}
              >
                <Pencil className='size-3.5' aria-hidden='true' />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('agentTokens.rename')}</TooltipContent>
          </Tooltip>
        </span>
        <span className='truncate text-xs text-muted-foreground'>{meta}</span>
      </div>
      <EndConnection row={row} t={t} />
    </div>
  );
});

interface EndConnectionProps {
  row: AgentConnectionItem;
  t: Translate;
}

/**
 * The button that ends a connection, and its confirmation: disconnect an
 * active client, remove an expired one, revoke a token. The confirmation
 * stays open while the answer is out and on failure.
 * @param props - The button's props.
 * @param props.row - The connection.
 * @param props.t - Translate.
 * @returns The button and its confirmation.
 */
function EndConnection({ row, t }: EndConnectionProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const kind = row.kind === 'pat' ? 'revoke' : row.status === 'expired' ? 'remove' : 'disconnect';
  const action = t(`agentTokens.${kind}`);
  const end = useMutation({
    mutationFn: () => agentAccessApi.disconnect(row.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AGENT_CONNECTIONS_KEY });
      setOpen(false);
    },
    onError: (err) => toast.error(failureMessage(err, t('agentTokens.actionFailed', { action }))),
  });
  const body =
    kind === 'revoke' && row.status === 'expired'
      ? t('agentTokens.revokeExpiredBody')
      : t(`agentTokens.${kind}Body`);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !end.isPending && setOpen(next)}>
      <Button variant='outline' onClick={() => setOpen(true)}>{action}</Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`agentTokens.${kind}Title`, { name: row.displayName })}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={end.isPending}>{t('agentTokens.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            loading={end.isPending}
            onClick={(event) => {
              event.preventDefault();
              end.mutate();
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * New personal access token: a name and a lifetime, then the plaintext shown
 * this once with a copy button.
 * @param props - The dialog's props.
 * @param props.t - Translate.
 * @returns The button and its dialog.
 */
function CreateTokenDialog({ t }: { t: Translate }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [expiry, setExpiry] = React.useState<string>(DEFAULT_EXPIRY);
  const [shown, setShown] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const create = useMutation({
    mutationFn: () => agentAccessApi.createToken(name.trim(), expiryOf(expiry)),
    onSuccess: async ({ token }) => {
      setShown(token);
      await queryClient.invalidateQueries({ queryKey: AGENT_CONNECTIONS_KEY });
    },
    onError: (err) => toast.error(failureMessage(err, t('agentTokens.createFailed'))),
  });
  /**
   * Open the dialog on a blank form, or close it, unless a token is being made.
   * @param next - Whether it opens.
   */
  const onOpenChange = (next: boolean): void => {
    if (create.isPending) return;
    setOpen(next);
    if (next) {
      setName('');
      setExpiry(DEFAULT_EXPIRY);
      setShown(null);
      setCopied(false);
    }
  };
  /**
   * Copy the plaintext token.
   */
  const onCopy = async (): Promise<void> => {
    if (shown === null) return;
    await navigator.clipboard.writeText(shown);
    setCopied(true);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button variant='outline' icon={<Plus className='size-4' />} onClick={() => onOpenChange(true)}>
        {t('agentTokens.newToken')}
      </Button>
      <DialogContent>
        {shown === null ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('agentTokens.newTokenTitle')}</DialogTitle>
              <DialogDescription>{t('agentTokens.newTokenBody')}</DialogDescription>
            </DialogHeader>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='agent-token-name'>{t('agentTokens.tokenName')}</Label>
              <Input
                id='agent-token-name'
                value={name}
                maxLength={AGENT_CONNECTION_NAME_MAX_LENGTH}
                autoComplete='off'
                placeholder={t('agentTokens.tokenNamePlaceholder')}
                disabled={create.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label>{t('agentTokens.tokenExpiry')}</Label>
              <Select value={expiry} onValueChange={setExpiry} disabled={create.isPending}>
                <SelectTrigger aria-label={t('agentTokens.tokenExpiry')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === 'never'
                        ? t('agentTokens.expiryNever')
                        : t('agentTokens.expiryDays', { days: Number(value) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant='outline' disabled={create.isPending} onClick={() => onOpenChange(false)}>
                {t('agentTokens.cancel')}
              </Button>
              <Button disabled={name.trim() === ''} loading={create.isPending} onClick={() => create.mutate()}>
                {t('agentTokens.generate')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('agentTokens.tokenShownTitle')}</DialogTitle>
              <DialogDescription>{t('agentTokens.tokenShownBody')}</DialogDescription>
            </DialogHeader>
            <div className='flex items-center gap-2 rounded-chrome border border-border bg-card p-2 font-mono text-xs'>
              <span className='min-w-0 flex-1 break-all'>{shown}</span>
              <Button variant='ghost' size='sm' icon={copied ? <Check className='size-4' /> : <Copy className='size-4' />} onClick={() => void onCopy()}>
                {copied ? t('agentTokens.copied') : t('agentTokens.copy')}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('agentTokens.done')}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
