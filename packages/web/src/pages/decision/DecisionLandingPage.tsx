// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one page every waiting request is answered on — `/decision?token=`.
 *
 * It replaces two nearly identical invite pages and serves five flows. What the
 * request IS only changes the wording, which is why the copy is one ICU select
 * on `kind` rather than five screens: a sixth flow adds an arm, not a page.
 *
 * The states it can land in used to collapse into one sentence. "Already
 * answered", "timed out", "withdrawn", "the project was deleted" and "this
 * token was never real" all read as `invalid link` before, and only the last
 * one actually is.
 *
 * Both entrances lead here — the email link and the bell row — so this is the
 * only place a decision is made in the UI, and the only place that has to
 * remember to refresh what a decision changes.
 */

import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from '@web/lib/toast';
import { expiresInLabel } from '@web/lib/expires-in';
import type { DecisionAction, DecisionView } from '@breatic/shared';
import { decisionsApi } from '@web/data/api/decisions';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';

/**
 * What the page is doing, as opposed to what the request is in.
 *
 * `invalid` and `unreachable` are the two ways a read ends without a view, and
 * conflating them is the mistake this page exists to stop making: only a token
 * the server has never issued is a bad link. A 500 or a dropped connection
 * leaves a live, answerable request on the other end, so telling that reader
 * to re-copy the link sends them after a problem they do not have.
 */
type Phase = 'loading' | 'ready' | 'invalid' | 'unreachable';

/**
 * The landing page for any of the five waiting-for-an-answer flows.
 * @returns The card for whatever state this request turned out to be in.
 */
export default function DecisionLandingPage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const token = params.get('token');

  const [phase, setPhase] = React.useState<Phase>(
    token === null ? 'invalid' : 'loading',
  );
  const [view, setView] = React.useState<DecisionView | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (token === null) return;
    let alive = true;
    setPhase('loading');
    void decisionsApi
      .view(token)
      .then((found) => {
        if (!alive) return;
        setView(found);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // 404 is the server saying no request answers to this token — the one
        // case that really is a bad link. Anything else happened to the read,
        // not to the request.
        const missing = err instanceof ApiException && err.status === 404;
        setPhase(missing ? 'invalid' : 'unreachable');
      });
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  const onRetry = React.useCallback((): void => setAttempt((n) => n + 1), []);

  const answer = React.useCallback(
    async (action: DecisionAction): Promise<void> => {
      if (token === null || view === null) return;
      setSubmitting(true);
      try {
        const result = await decisionsApi.respond(token, action);
        // Deciding changes what the rest of the app shows: the bell row is
        // done, and accepting a studio or a transfer changes the rail. Both
        // used to be refreshed by the bell's own mutation, which is being
        // deleted — so the refresh moves here, before navigating away.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['notifications', 'unread'] }),
          queryClient.invalidateQueries({ queryKey: ['studios', 'user'] }),
        ]);
        if (result.redirectTo !== null) {
          navigate(result.redirectTo, { replace: true });
          return;
        }
        setView({ ...view, state: result.state });
      } catch (err) {
        toast.error(
          err instanceof ApiException && err.message !== ''
            ? err.message
            : t('decision.actionFailed'),
        );
        // A refusal is the server saying the view went stale while the page
        // sat open — the deadline passed, somebody else answered. Follow it:
        // without this the card keeps live buttons under a countdown that
        // says "expired", and every click repeats the same refusal.
        const fresh = await decisionsApi.view(token).catch(() => null);
        if (fresh !== null) setView(fresh);
      } finally {
        setSubmitting(false);
      }
    },
    [navigate, queryClient, t, token, view],
  );

  const onConfirm = React.useCallback((): void => void answer('confirm'), [answer]);
  const onDecline = React.useCallback((): void => void answer('decline'), [answer]);

  if (phase === 'loading') {
    return (
      <AuthCardShell title={t('decision.loadingTitle')}>
        <div className='flex items-center gap-2 text-muted-foreground'>
          <Loader2 className='size-4 animate-spin' aria-hidden />
          <span className='text-sm'>{t('decision.loadingBody')}</span>
        </div>
      </AuthCardShell>
    );
  }

  // Nothing automatic here on purpose: no reconnect loop, no backoff, no
  // separate wording per status code. The read failed, the link is fine, and
  // asking again is the whole remedy.
  if (phase === 'unreachable') {
    return (
      <AuthCardShell
        title={t('decision.unreachableTitle')}
        footer={<AuthLink to='/studio'>{t('decision.backHome')}</AuthLink>}
      >
        <div className='flex flex-col items-start gap-4'>
          <p className='text-sm text-muted-foreground'>
            {t('decision.unreachableBody')}
          </p>
          <Button onClick={onRetry}>{t('decision.retry')}</Button>
        </div>
      </AuthCardShell>
    );
  }

  if (phase === 'invalid' || view === null) {
    return (
      <AuthCardShell
        title={t('decision.invalidTitle')}
        footer={<AuthLink to='/studio'>{t('decision.backHome')}</AuthLink>}
      >
        <p className='text-sm text-muted-foreground'>{t('decision.invalidBody')}</p>
      </AuthCardShell>
    );
  }

  // `gone` outranks the audience check, and only `gone`. Every other card
  // past this point either speaks to the recipient in the second person
  // ("You already accepted this") or is about a request that still exists and
  // still belongs to somebody — for those, "this link was sent to somebody
  // else" is the true thing to say.
  //
  // A deleted container has no recipient to be. The role upgrade resolves its
  // recipient through the project's current owner, so deleting the project
  // makes even the person who WAS asked stop matching, and the audience check
  // would tell them the link is somebody else's — false about the one person
  // it was sent to. This card claims nothing about the viewer, so it is the
  // honest answer to anyone holding the link.
  if (view.state === 'gone') {
    return (
      <AuthCardShell
        title={t('decision.goneTitle')}
        footer={<AuthLink to='/studio'>{t('decision.backHome')}</AuthLink>}
      >
        <p className='text-sm text-muted-foreground'>{t('decision.goneBody')}</p>
      </AuthCardShell>
    );
  }

  // Everything below is a request that WAS found and still has a container.
  // Who is looking is decided BEFORE what state it is in, for the reason
  // above.
  if (!view.isRecipient) {
    return (
      <AuthCardShell
        title={t('decision.notYoursTitle')}
        footer={<AuthLink to='/studio'>{t('decision.backHome')}</AuthLink>}
      >
        <p className='text-sm text-muted-foreground'>
          {t('decision.notYoursBody')}
        </p>
      </AuthCardShell>
    );
  }

  // Which card the recipient gets is the state the server worked out, not
  // something this component re-derives.
  const vars = {
    kind: view.kind,
    actor: view.actorName,
    entity: view.entityName,
    role: view.role ?? '',
  };

  if (view.state !== 'answerable') {
    const copy: Record<string, { title: string; body: string }> = {
      accepted: {
        title: t('decision.acceptedTitle'),
        body: t('decision.acceptedBody'),
      },
      declined: {
        title: t('decision.declinedTitle'),
        body: t('decision.declinedBody'),
      },
      expired: {
        title: t('decision.expiredTitle'),
        body: t('decision.expiredBody'),
      },
      revoked: {
        title: t('decision.revokedTitle'),
        body: t('decision.revokedBody'),
      },
      gone: { title: t('decision.goneTitle'), body: t('decision.goneBody') },
      already_member: {
        title: t('decision.alreadyMemberTitle'),
        body: t('decision.alreadyMemberBody'),
      },
    };
    const card = copy[view.state] ?? {
      title: t('decision.invalidTitle'),
      body: t('decision.invalidBody'),
    };
    return (
      <AuthCardShell
        title={card.title}
        footer={<AuthLink to='/studio'>{t('decision.backHome')}</AuthLink>}
      >
        <div className='flex flex-col gap-4'>
          <p className='text-sm text-muted-foreground'>{card.body}</p>
          {/* Deliberately no date: an exact instant reads as a promise the
              reaper does not keep. How long the window WAS is the part that
              answers "why can't I answer this". */}
          {view.state === 'expired' && (
            <p className='text-xs text-muted-foreground'>
              {t('decision.windowNote', { days: view.windowDays })}
            </p>
          )}
          {view.destination !== null && (
            <div>
              <AuthLink to={view.destination}>{t('decision.goThere')}</AuthLink>
            </div>
          )}
        </div>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell title={t('decision.title', vars)}>
      <div className='flex flex-col gap-4'>
        <p className='text-sm text-muted-foreground'>{t('decision.body', vars)}</p>
        {view.message !== null && view.message !== '' && (
          <p className='text-sm text-muted-foreground'>
            {t('decision.reason', { message: view.message })}
          </p>
        )}
        {/* The bell's own formatter, so the two surfaces can never disagree
            about how long is left on the same request. The static "within N
            days" line lives on the expired card, where it answers WHY. */}
        {view.expiresAt !== null && (
          <p className='text-xs text-muted-foreground'>
            {expiresInLabel(view.expiresAt, t)}
          </p>
        )}
        <div className='flex gap-2'>
          <Button onClick={onConfirm} disabled={submitting}>
            {t('decision.confirm', vars)}
          </Button>
          <Button variant='outline' onClick={onDecline} disabled={submitting}>
            {t('decision.decline', vars)}
          </Button>
        </div>
      </div>
    </AuthCardShell>
  );
}
