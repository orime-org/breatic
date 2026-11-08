// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { getLocale, normalizeEmail, REFERRAL_CODE_INPUT_MAX } from '@breatic/shared';
import type { SignupInvitationPreview } from '@breatic/shared';

import { authApi, type AuthUser, type SignupCodeSent, type SignupReferralOutcome } from '@web/data/api/auth';
import { toCurrentUser, useCurrentUserStore } from '@web/stores/current-user';
import { ApiException } from '@web/data/api/types';
import { attributionBody, failureCode, reportConversion, trackEvent } from '@web/data/analytics';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { PasswordInput } from '@web/components/ui/password-input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';
import { TermsNotice } from '@web/pages/auth/_shared/TermsNotice';
import { FieldError } from '@web/components/FieldError';
import { SignupCodeStep } from '@web/pages/auth/SignupCodeStep';
import { looksLikeEmail } from '@web/lib/looks-like-email';
import { safeNextPath } from '@web/lib/safe-next-path';
import { toast } from '@web/lib/toast';
import { Skeleton } from '@web/components/ui/skeleton';
import { useSignupReferral } from '@web/features/referral/use-signup-referral';
import { GoogleSignIn } from '@web/pages/auth/GoogleSignIn';
import { changeLocale } from '@web/i18n/locale-bootstrap';

declare const __GOOGLE_CLIENT_ID__: string;

/**
 * Whether the server refused a sign-up for its referral code.
 * @param err - What the request threw.
 * @returns True for the referral field's refusal.
 */
function referralRefused(err: unknown): err is ApiException {
  return err instanceof ApiException && err.status === 422 && err.reason === 'invalid_code';
}

/**
 * Email + password registration — step one of the two-step sign-up.
 *
 * The server answers the form one of two ways:
 *
 *   - `code_sent` (an email backend is enabled, #287): nothing is created
 *     yet. The same card turns into the code step; a matching code creates
 *     the account, signs it in and goes straight to the slug page. There is
 *     no recovery code — password recovery goes by email.
 *   - `created` (no email backend): the account exists and is signed in; we
 *     go to `/recovery-code` to have the one-time recovery code saved — the
 *     only way back in without email — and from there to the slug page.
 *
 * Either way the account has NO personal studio yet (`personalStudio ===
 * null`); the gate in `ProtectedRoute` keeps a half-finished sign-up on
 * `/choose-slug` until the slug is picked.
 * @returns the registration form, or the code step once a code was sent.
 */
export default function RegisterPage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const inviteToken = params.get('invite') || null;
  const decisionPath = inviteToken ? `/decision?token=${encodeURIComponent(inviteToken)}` : null;
  const next = decisionPath ?? safeNextPath(params.get('next'));
  const carriesNext = decisionPath !== null || params.has('next');
  const slugPath = carriesNext ? `/choose-slug?next=${encodeURIComponent(next)}` : '/choose-slug';
  const loginPath = carriesNext ? `/login?next=${encodeURIComponent(next)}` : '/login';
  const setUser = useCurrentUserStore((s) => s.setUser);
  const referral = useSignupReferral();

  const invitation = useQuery({
    queryKey: ['auth', 'invitation', inviteToken],
    queryFn: () => authApi.invitation(inviteToken ?? ''),
    enabled: inviteToken !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview: SignupInvitationPreview | undefined = invitation.data;
  const openInvitation = preview?.state === 'open' ? preview : null;
  const [emailDraft, setEmailDraft] = React.useState<{ token: string | null; value: string } | null>(null);
  const email = emailDraft && emailDraft.token === inviteToken
    ? emailDraft.value
    : openInvitation?.email ?? '';
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errors, setErrors] = React.useState<{
    email?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [codeSent, setCodeSent] = React.useState<SignupCodeSent | null>(null);

  const previewClosed = invitation.data?.state === 'closed'
    || (invitation.error instanceof ApiException && invitation.error.status === 404);
  const previewFailed = invitation.isError && !previewClosed;
  const previewPending = inviteToken !== null && invitation.isPending;
  const banner = openInvitation ? t('auth.register.invitedBanner', {
    inviterName: openInvitation.inviterName,
    targetName: openInvitation.targetName,
  }) : null;
  const closedMessage = t('auth.register.inviteClosed');
  const loadingMessage = t('common.loading');
  const previewError = invitation.error instanceof ApiException && invitation.error.fromServer
    ? invitation.error.message
    : t('common.pageUnavailable.message');
  const retryLabel = t('common.pageUnavailable.action');
  const { refetch } = invitation;

  /** Reload the invitation preview while retaining the current form values. */
  const retryInvitation = React.useCallback((): void => {
    void refetch();
  }, [refetch]);

  const intro = React.useMemo((): React.ReactNode => {
    if (inviteToken === null) return null;
    if (previewFailed) {
      return (
        <div className='mb-4 flex flex-col gap-2'>
          <FieldError>{previewError}</FieldError>
          <Button type='button' variant='outline' onClick={retryInvitation}>
            {retryLabel}
          </Button>
        </div>
      );
    }
    const message = previewPending ? loadingMessage : previewClosed ? closedMessage : banner;
    return message ? (
      <div className='mb-4 rounded-content-sm border border-border bg-muted px-3 py-2.5 text-sm'>
        {message}
      </div>
    ) : null;
  }, [inviteToken, previewFailed, previewError, retryInvitation, retryLabel, previewPending, loadingMessage, previewClosed, closedMessage, banner]);

  /**
   * Send the form's email and password and follow the answer.
   * @param trimmedEmail - the address as submitted
   * @returns the code-sent answer, or `null` when the sign-up went another way
   *   (created, or refused — the refusal is shown on the form)
   */
  const register = React.useCallback(
    async (trimmedEmail: string): Promise<SignupCodeSent | null> => {
      try {
        const answer = await authApi.register({ email: trimmedEmail, password, ...attributionBody(), ...referral.body() });
        if (answer.status === 'code_sent') {
          setCodeSent(answer);
          return answer;
        }
        referral.used();
        // Step one creates the account with no personal studio yet — the
        // store mirrors that null so the onboarding gate is consistent
        // even before the recovery dialog is dismissed.
        setUser(toCurrentUser(answer.user));
        reportConversion('signup', `signup:${answer.user.id}`);
        navigate('/recovery-code', {
          state: { code: answer.recoveryCode, next: slugPath },
          replace: true,
        });
        return null;
      } catch (err) {
        setCodeSent(null);
        trackEvent('signup_failed', { method: 'email', success: false, error_code: failureCode(err) });
        if (referralRefused(err)) referral.refused(t('auth.referral.invalid'));
        else setFormError(err instanceof ApiException ? err.message : t('auth.register.failed'));
        return null;
      }
    },
    [password, setUser, navigate, slugPath, t, referral],
  );

  const restart = React.useCallback(
    (): Promise<SignupCodeSent | null> => register(email.trim()),
    [register, email],
  );

  const handleVerified = React.useCallback(
    (user: AuthUser, outcome?: SignupReferralOutcome): void => {
      setUser(toCurrentUser(user));
      reportConversion('signup', `signup:${user.id}`);
      referral.used();
      // Before navigating: the Toaster sits outside the router and keeps it (inner#1868 §10).
      if (outcome === 'not_applied') toast.warning(t('auth.referral.notApplied'));
      navigate(slugPath, { replace: true });
    },
    [setUser, navigate, slugPath, referral, t],
  );

  /**
   * Exchange a Google credential, carrying the referral code to a new account.
   * @param credential - The ID token from Google's SDK.
   */
  const handleGoogleCredential = React.useCallback(
    async (credential: string): Promise<void> => {
      if (submitting) return;
      setSubmitting(true);
      setFormError(null);
      trackEvent('signup_started', { method: 'google' });
      try {
        const answer = await authApi.google({ credential, ...attributionBody(), ...referral.body() });
        setUser(toCurrentUser(answer.user));
        // An existing account keeps the carried code: the warning below points to the panel, which fills from it.
        if (answer.created) {
          reportConversion('signup', `signup:${answer.user.id}`);
          referral.used();
        }
        if (answer.referral === 'not_applied') toast.warning(t('auth.referral.existingAccount'));
        void changeLocale(answer.user.locale);
        navigate(answer.created ? slugPath : next, { replace: true });
      } catch (err) {
        if (referralRefused(err)) referral.refused(t('auth.referral.invalid'));
        else setFormError(err instanceof ApiException ? err.message : t('auth.register.failed'));
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, referral, setUser, t, navigate, slugPath, next],
  );

  const handleChangeEmail = React.useCallback((): void => {
    setCodeSent(null);
    setFormError(null);
  }, []);

  /**
   * Validate the fields client-side and send them.
   * @param e - the form submit event, prevented so the page does not reload
   */
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    const trimmedEmail = email.trim();
    const nextErrors: typeof errors = {};
    if (!looksLikeEmail(trimmedEmail)) {
      nextErrors.email = t('auth.invalidEmail');
    }
    if (password.length < 8) nextErrors.password = t('auth.passwordTooShort');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setEmailDraft({ token: inviteToken, value: trimmedEmail });
    setSubmitting(true);
    trackEvent('signup_started', { method: 'email' });
    try {
      await register(trimmedEmail);
    } finally {
      setSubmitting(false);
    }
  }

  if (invitation.data?.state === 'claimed' && decisionPath) {
    return <Navigate to={decisionPath} replace />;
  }

  if (codeSent) {
    return (
      <SignupCodeStep
        email={email.trim()}
        sent={codeSent}
        restart={restart}
        onVerified={handleVerified}
        onChangeEmail={handleChangeEmail}
      />
    );
  }

  return (
    <>
      <AuthCardShell
        showVersion
        title={t('auth.register.title')}
        notice={<TermsNotice />}
        subtitle={t('auth.register.subtitle')}
        intro={intro}
        footer={
          <>
            {t('auth.register.haveAccount')}{' '}
            <AuthLink to={loginPath}>{t('auth.register.signIn')}</AuthLink>
          </>
        }
      >
        <form onSubmit={handleSubmit} noValidate className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='register-email'>{t('auth.email')}</Label>
            <Input
              id='register-email'
              type='email'
              autoComplete='email'
              value={email}
              onChange={(e) => {
                setEmailDraft({ token: inviteToken, value: e.target.value });
                if (errors.email) setErrors((p) => ({ ...p, email: undefined }));
              }}
              readOnly={submitting}
              aria-invalid={!!errors.email || undefined}
              aria-describedby={errors.email ? 'register-email-error' : undefined}
            />
            {errors.email ? (
              <FieldError id='register-email-error'>{errors.email}</FieldError>
            ) : null}
            {openInvitation && normalizeEmail(email) !== normalizeEmail(openInvitation.email) ? (
              <p className='text-xs text-muted-foreground'>
                {t('auth.register.invitedEmailMismatch', { email: openInvitation.email })}
              </p>
            ) : null}
          </div>

          <div className='flex flex-col gap-1'>
            <Label htmlFor='register-password'>{t('auth.password')}</Label>
            <PasswordInput
              id='register-password'
              autoComplete='new-password'
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (errors.password) setErrors((p) => ({ ...p, password: undefined }));
              }}
              readOnly={submitting}
              aria-invalid={!!errors.password || undefined}
              aria-describedby={errors.password ? 'register-password-error' : undefined}
              showLabel={t('auth.passwordShow')}
              hideLabel={t('auth.passwordHide')}
            />
            {errors.password ? (
              <FieldError id='register-password-error'>{errors.password}</FieldError>
            ) : (
              <p className='text-xs text-muted-foreground'>
                {t('auth.register.passwordHint')}
              </p>
            )}
          </div>

          {referral.field === 'loading' ? (
            <div className='flex flex-col gap-1' data-testid='register-referral-loading'>
              <Skeleton className='h-4 w-24' />
              <Skeleton className='h-9 w-full' />
            </div>
          ) : referral.field === 'shown' ? (
            <div className='flex flex-col gap-1'>
              <div className='flex items-baseline justify-between'>
                <Label htmlFor='register-referral'>{t('auth.referral.label')}</Label>
                <span className='text-xs text-muted-foreground'>{t('auth.referral.optional')}</span>
              </div>
              <Input
                id='register-referral'
                autoComplete='off'
                maxLength={REFERRAL_CODE_INPUT_MAX}
                value={referral.value}
                placeholder={t('auth.referral.placeholder')}
                onChange={(e) => referral.change(e.target.value)}
                readOnly={submitting}
                aria-invalid={!!referral.error || undefined}
                aria-describedby={referral.error ? 'register-referral-error' : undefined}
              />
              {referral.error ? <FieldError id='register-referral-error'>{referral.error}</FieldError> : null}
            </div>
          ) : null}

          {formError ? (
            <FieldError role='alert' className='mt-1'>{formError}</FieldError>
          ) : null}

          <Button type='submit' size='form' loading={submitting} disabled={referral.field === 'loading'} className='mt-2'>
            {submitting
              ? t('auth.register.creating')
              : t('auth.register.create')}
          </Button>
        </form>
        {typeof __GOOGLE_CLIENT_ID__ === 'string' && __GOOGLE_CLIENT_ID__ !== '' ? (
          <div className='mt-4 flex flex-col gap-3'>
            <div className='flex items-center gap-2 text-xs text-muted-foreground'>
              <div className='h-px flex-1 bg-border' />
              <span>{t('auth.or')}</span>
              <div className='h-px flex-1 bg-border' />
            </div>
            <GoogleSignIn
              key={getLocale()}
              clientId={__GOOGLE_CLIENT_ID__}
              busy={submitting || referral.field === 'loading'}
              onCredential={handleGoogleCredential}
            />
          </div>
        ) : null}
      </AuthCardShell>
    </>
  );
}
