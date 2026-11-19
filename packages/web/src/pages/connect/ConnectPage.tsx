// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The consent page an external agent's authorization opens (#1488 §5.3):
 * who is asking, where the answer goes, what allowing lets it do, and the
 * two answers. The authorization server sends the browser here as
 * `/connect/:uid`; allowing or refusing hands the browser back to it, and it
 * returns to the agent.
 */

import * as React from 'react';
import { useParams } from 'react-router-dom';
import { Coins, FolderOpen, Sparkles, TriangleAlert } from 'lucide-react';
import type { OAuthInteractionView } from '@breatic/shared';
import { oauthInteractionsApi } from '@web/data/api/oauth-interactions';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell } from '@web/pages/auth/_shared/AuthCardShell';
import { useCurrentUserStore } from '@web/stores/current-user';

type Phase = 'loading' | 'ready' | 'unreachable' | 'expired' | 'allowed' | 'denied';

/** Which answer is being sent. */
type Answer = 'allow' | 'deny';

/**
 * Whether a failed call means the request is gone: the server answers 404 for
 * an interaction that expired, was used, or belongs to another browser.
 * @param err - What the call threw.
 * @returns True when the request is gone.
 */
function isGone(err: unknown): boolean {
  return err instanceof ApiException && err.status === 404;
}

/**
 * The consent page.
 * @returns The page.
 */
export default function ConnectPage(): React.JSX.Element {
  const t = useTranslation();
  const { uid = '' } = useParams<{ uid: string }>();
  const email = useCurrentUserStore((s) => s.user?.email ?? '');
  const [phase, setPhase] = React.useState<Phase>('loading');
  const [view, setView] = React.useState<OAuthInteractionView | null>(null);
  const [sending, setSending] = React.useState<Answer | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setPhase('loading');
    oauthInteractionsApi
      .view(uid)
      .then((found) => {
        if (!alive) return;
        setView(found);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (alive) setPhase(isGone(err) ? 'expired' : 'unreachable');
      });
    return () => {
      alive = false;
    };
  }, [uid, attempt]);

  const onRetry = React.useCallback((): void => setAttempt((n) => n + 1), []);

  const answer = React.useCallback(
    async (choice: Answer): Promise<void> => {
      setSending(choice);
      try {
        const { redirectTo } = choice === 'allow' ? await oauthInteractionsApi.confirm(uid) : await oauthInteractionsApi.abort(uid);
        setPhase(choice === 'allow' ? 'allowed' : 'denied');
        window.location.assign(redirectTo);
      } catch (err) {
        if (isGone(err)) setPhase('expired');
        else toast.error(t('agentConnect.answerFailed'));
      } finally {
        setSending(null);
      }
    },
    [t, uid],
  );
  const onAllow = React.useCallback((): void => void answer('allow'), [answer]);
  const onDeny = React.useCallback((): void => void answer('deny'), [answer]);

  if (phase === 'loading') {
    return (
      <AuthCardShell title={t('agentConnect.loadingTitle')}>
        <div className='flex flex-col gap-3'>
          <Skeleton className='h-4 w-2/3' />
          <Skeleton className='h-4 w-full' />
          <Skeleton className='h-4 w-full' />
        </div>
      </AuthCardShell>
    );
  }

  if (phase === 'unreachable') {
    return (
      <AuthCardShell title={t('agentConnect.loadFailedTitle')}>
        <div className='flex flex-col items-start gap-4'>
          <p className='text-sm text-muted-foreground'>{t('agentConnect.loadFailedBody')}</p>
          <Button variant='outline' onClick={onRetry}>{t('agentConnect.retry')}</Button>
        </div>
      </AuthCardShell>
    );
  }

  if (phase === 'expired' || view === null) {
    return (
      <AuthCardShell title={t('agentConnect.expiredTitle')}>
        <p className='text-sm text-muted-foreground'>{t('agentConnect.expiredBody')}</p>
      </AuthCardShell>
    );
  }

  if (phase === 'allowed' || phase === 'denied') {
    return (
      <AuthCardShell title={t(phase === 'allowed' ? 'agentConnect.allowedTitle' : 'agentConnect.deniedTitle')}>
        <p className='text-sm text-muted-foreground'>{t('agentConnect.returningBody', { client: view.clientName })}</p>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={t('agentConnect.title', { client: view.clientName })}
      subtitle={t('agentConnect.returnHost', { host: view.redirectHosts.join(', ') })}
    >
      <div className='flex flex-col gap-5'>
        {view.localhostOnly ? (
          <div className='flex gap-2 rounded-chrome border border-border bg-muted p-3 text-xs text-muted-foreground'>
            <TriangleAlert className='size-4 shrink-0' aria-hidden='true' />
            <span>{t('agentConnect.localhostNotice')}</span>
          </div>
        ) : null}
        <section className='flex flex-col gap-3 text-sm'>
          <h2 className='text-xs font-semibold text-muted-foreground'>{t('agentConnect.canHeading')}</h2>
          <p className='flex gap-2'><FolderOpen className='mt-0.5 size-4 shrink-0' aria-hidden='true' />{t('agentConnect.canEdit')}</p>
          <p className='flex gap-2'><Sparkles className='mt-0.5 size-4 shrink-0' aria-hidden='true' />{t('agentConnect.canGenerate')}</p>
          <p className='flex gap-2'><Coins className='mt-0.5 size-4 shrink-0' aria-hidden='true' />{t('agentConnect.canSpend')}</p>
        </section>
        <p className='text-xs text-muted-foreground'>{t('agentConnect.account', { email })}</p>
        <div className='flex justify-end gap-2'>
          <Button variant='outline' disabled={sending === 'allow'} loading={sending === 'deny'} onClick={onDeny}>{t('agentConnect.deny')}</Button>
          <Button disabled={sending === 'deny'} loading={sending === 'allow'} onClick={onAllow}>{t('agentConnect.allow')}</Button>
        </div>
      </div>
    </AuthCardShell>
  );
}
