// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';
import { FieldError } from '@web/pages/auth/_shared/FieldError';

/**
 * Forgot-password entry. It offers the one way back in that works on this
 * deployment, as `GET /auth/options` reports it:
 *
 *   - email enabled → `POST /auth/forgot-password` mails a reset link. An
 *     account made here proved its address with a code at sign-up, so the
 *     mailbox is the way back.
 *   - email disabled → `/reset-password?mode=recovery`, where the reader types
 *     the recovery code saved at sign-up. Nothing can be mailed, so the page
 *     does not offer to.
 */
type Step = 'choose' | 'email-sent';

/** What this deployment offers, once the server has said. */
type Mode = 'loading' | 'failed' | 'email' | 'recovery';

/**
 * Forgot-password page: offer the way back in this deployment supports, then
 * show the "email sent" confirmation after a reset link was requested.
 * @returns the page in its loading, failed, recovery-code, email-form or
 * email-sent state.
 */
export default function ForgotPasswordPage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();

  const [step, setStep] = React.useState<Step>('choose');
  const [mode, setMode] = React.useState<Mode>('loading');

  React.useEffect(() => {
    let cancelled = false;
    authApi
      .options()
      .then(({ emailVerification }) => {
        if (!cancelled) setMode(emailVerification ? 'email' : 'recovery');
      })
      .catch(() => {
        if (!cancelled) setMode('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [email, setEmail] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  /**
   * Validate the email client-side, then request a reset link from the
   * server and advance to the "email sent" confirmation step.
   * @param e - the form submit event, prevented so the page does not reload
   */
  async function handleEmailSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setEmailError(t('auth.invalidEmail'));
      return;
    }
    setEmailError(null);
    setSubmitting(true);
    try {
      await authApi.forgotPassword({ email: trimmedEmail });
      setStep('email-sent');
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.forgot.failed');
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'email-sent') {
    return (
      <AuthCardShell
        title={t('auth.forgot.sentTitle')}
        subtitle={t('auth.forgot.sentSubtitle')}
        footer={<AuthLink to='/login'>{t('auth.forgot.backToSignIn')}</AuthLink>}
      >
        <p className='text-sm text-muted-foreground'>
          {t('auth.forgot.sentBody', { email })}
        </p>
      </AuthCardShell>
    );
  }

  const footer = <AuthLink to='/login'>{t('auth.forgot.backToSignIn')}</AuthLink>;

  if (mode === 'loading') {
    return (
      <AuthCardShell title={t('auth.forgot.title')} footer={footer}>
        <div className='flex flex-col gap-3' data-testid='forgot-loading'>
          <Skeleton className='h-4 w-2/3' />
          <Skeleton className='h-[var(--control-height)] w-full' />
          <Skeleton className='h-[var(--control-height)] w-full' />
        </div>
      </AuthCardShell>
    );
  }

  if (mode === 'failed') {
    return (
      <AuthCardShell title={t('auth.forgot.title')} footer={footer}>
        <FieldError role='alert'>{t('auth.forgot.optionsFailed')}</FieldError>
      </AuthCardShell>
    );
  }

  if (mode === 'recovery') {
    return (
      <AuthCardShell
        title={t('auth.forgot.title')}
        subtitle={t('auth.forgot.subtitleRecovery')}
        footer={footer}
      >
        <Button
          type='button'
          size='form'
          variant='outline'
          onClick={() => navigate('/reset-password?mode=recovery')}
          className='w-full'
        >
          {t('auth.forgot.useRecoveryCode')}
        </Button>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={t('auth.forgot.title')}
      subtitle={t('auth.forgot.subtitleEmail')}
      footer={footer}
    >
      <form onSubmit={handleEmailSubmit} noValidate className='flex flex-col gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='forgot-email'>{t('auth.email')}</Label>
          <Input
            id='forgot-email'
            type='email'
            autoComplete='email'
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError(null);
            }}
            disabled={submitting}
            aria-invalid={!!emailError || undefined}
            aria-describedby={emailError ? 'forgot-email-error' : undefined}
          />
          {emailError ? (
            <FieldError id='forgot-email-error'>{emailError}</FieldError>
          ) : null}
        </div>

        {formError ? (
          <FieldError role='alert' className='mt-1'>{formError}</FieldError>
        ) : null}

        <Button type='submit' size='form' disabled={submitting} className='mt-2'>
          {submitting
            ? t('auth.forgot.sending')
            : t('auth.forgot.sendResetLink')}
        </Button>
      </form>
    </AuthCardShell>
  );
}
