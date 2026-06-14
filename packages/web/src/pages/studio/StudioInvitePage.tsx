// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import type { InvitationLandingView } from '@breatic/shared';
import { studiosApi } from '@web/data/api/studios';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';

/**
 * Resolved state of the invite landing page. The view is fetched on mount;
 * the outcome forks on the token (`invalid`), the invitee identity
 * (`notMine`), the invite window (`expired`), and the decline action
 * (`declined`). A successful confirm navigates away (no terminal phase).
 */
type Phase =
  | 'loading'
  | 'invalid'
  | 'expired'
  | 'notMine'
  | 'ready'
  | 'declined';

/**
 * Studio invitation landing page — `/studio-invite?token=xxx`.
 *
 * Entry point for the OPTIONAL email-link path of the invite-confirm
 * handshake (the always-delivered path is the bell notification, since an
 * invitee may not have a working inbox). The invitee lands here from the
 * email; the page mirrors the bell action — it does NOT auto-accept. On
 * mount it peeks the invite (GET, no token consume) and renders the studio
 * + inviter + role; the invitee then confirms (→ joins, redirect to the
 * studio) or declines.
 *
 * Both backend endpoints are auth-only, so the route is wrapped in
 * `ProtectedRoute`: an unauthenticated click bounces to `/login` (the
 * originally-requested path is preserved in router state) and returns here
 * after sign-in.
 *
 * States: `loading` (peeking) · `invalid` (no token / token gone, 404) ·
 * `expired` (7-day window elapsed) · `notMine` (signed in as someone other
 * than the invitee) · `ready` (the invitee, live invite → confirm/decline) ·
 * `declined` (terminal "you declined" card). A successful confirm navigates
 * to `/studio/{slug}`, so it has no terminal phase here.
 * @returns the invitation landing page in one of its six states.
 */
export default function StudioInvitePage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');

  const [phase, setPhase] = React.useState<Phase>(
    token ? 'loading' : 'invalid',
  );
  const [view, setView] = React.useState<InvitationLandingView | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await studiosApi.getInvitation(token);
        if (cancelled) return;
        setView(result);
        setPhase(
          !result.isInvitee ? 'notMine' : result.expired ? 'expired' : 'ready',
        );
      } catch {
        // 404 (token expired / consumed / invite gone) and any other failure
        // collapse to the same friendly "link no longer valid" card — there is
        // nothing actionable to distinguish for the invitee.
        if (!cancelled) setPhase('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  /**
   * Confirm or decline the invite via the one-time token. Confirm joins and
   * redirects to the studio; decline lands the terminal "declined" card. A
   * failure (already decided / expired between load and click) surfaces a toast
   * and re-enables the buttons.
   * @param action - `confirm` to accept and join, `decline` to refuse.
   * @returns once the response has been recorded (or surfaced as a toast).
   */
  async function respond(action: 'confirm' | 'decline'): Promise<void> {
    if (!token || submitting) return;
    setSubmitting(true);
    try {
      const res = await studiosApi.respondInvitation(token, action);
      if (action === 'confirm') {
        toast.success(t('studio.invite.joinedToast'));
        navigate(`/studio/${res.studioSlug}`, { replace: true });
      } else {
        setPhase('declined');
      }
    } catch (err) {
      setSubmitting(false);
      toast.error(
        err instanceof ApiException
          ? err.message
          : t('studio.invite.actionFailed'),
      );
    }
  }

  if (phase === 'loading') {
    return (
      <AuthCardShell title={t('studio.invite.loadingTitle')}>
        <div className='flex items-center justify-center gap-3 py-4 text-muted-foreground'>
          <Loader2 className='h-5 w-5 animate-spin' aria-hidden />
          <span className='text-sm'>{t('studio.invite.loadingBody')}</span>
        </div>
      </AuthCardShell>
    );
  }

  if (phase === 'invalid') {
    return (
      <AuthCardShell
        title={t('studio.invite.invalidTitle')}
        footer={
          <AuthLink to='/studio'>{t('studio.invite.backToStudio')}</AuthLink>
        }
      >
        <p className='text-sm text-muted-foreground'>
          {t('studio.invite.invalidBody')}
        </p>
      </AuthCardShell>
    );
  }

  if (phase === 'notMine') {
    return (
      <AuthCardShell
        title={t('studio.invite.notInviteeTitle')}
        footer={<AuthLink to='/login'>{t('studio.invite.signIn')}</AuthLink>}
      >
        <p className='text-sm text-muted-foreground'>
          {t('studio.invite.notInviteeBody')}
        </p>
      </AuthCardShell>
    );
  }

  if (phase === 'expired') {
    return (
      <AuthCardShell
        title={t('studio.invite.expiredTitle')}
        footer={
          <AuthLink to='/studio'>{t('studio.invite.backToStudio')}</AuthLink>
        }
      >
        <p className='text-sm text-muted-foreground'>
          {t('studio.invite.expiredBody', { studio: view?.studioName ?? '' })}
        </p>
      </AuthCardShell>
    );
  }

  if (phase === 'declined') {
    return (
      <AuthCardShell
        title={t('studio.invite.declinedTitle')}
        footer={
          <AuthLink to='/studio'>{t('studio.invite.backToStudio')}</AuthLink>
        }
      >
        <p className='text-sm text-muted-foreground'>
          {t('studio.invite.declinedBody', { studio: view?.studioName ?? '' })}
        </p>
      </AuthCardShell>
    );
  }

  // phase === 'ready' — the invitee, a live invite → the confirm/decline card.
  return (
    <AuthCardShell title={t('studio.invite.title')}>
      <p className='text-sm text-muted-foreground'>
        {t('studio.invite.body', {
          inviter: view?.inviterName ?? '',
          studio: view?.studioName ?? '',
          role: view?.role ?? 'member',
        })}
      </p>
      <div className='mt-5 flex gap-3'>
        <Button
          type='button'
          size='form'
          className='flex-1'
          disabled={submitting}
          onClick={() => void respond('confirm')}
        >
          {submitting ? (
            <Loader2 className='h-4 w-4 animate-spin' aria-hidden />
          ) : (
            t('studio.invite.confirm')
          )}
        </Button>
        <Button
          type='button'
          variant='outline'
          size='form'
          className='flex-1'
          disabled={submitting}
          onClick={() => void respond('decline')}
        >
          {t('studio.invite.decline')}
        </Button>
      </div>
    </AuthCardShell>
  );
}
