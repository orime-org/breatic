// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { REFERRAL_CODE_INPUT_MAX } from '@breatic/shared';
import { GoogleSignIn } from '@web/pages/auth/GoogleSignIn';
import { keptQuery, saveGoogleStart } from '@web/pages/auth/google-return';
import { useGoogleArrival, useGoogleReturn, useGoogleSignInShown } from '@web/pages/auth/use-google-return';
import { DesktopGoogleSignIn } from '@web/pages/auth/DesktopGoogleSignIn';
import { getDesktopBridge } from '@web/lib/desktop-bridge';

import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { trackEvent } from '@web/data/analytics';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { PasswordInput } from '@web/components/ui/password-input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { useCompleteSignIn } from '@web/pages/auth/use-complete-sign-in';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';
import { TermsNotice } from '@web/pages/auth/_shared/TermsNotice';
import { FieldError } from '@web/components/FieldError';
import { looksLikeEmail } from '@web/lib/looks-like-email';
import { safeNextPath } from '@web/lib/safe-next-path';
import { renderSlottedText, slotMarker } from '@web/lib/slotted-text';
import { Skeleton } from '@web/components/ui/skeleton';
import { useSignupReferral } from '@web/features/referral/use-signup-referral';
import { X } from 'lucide-react';

/**
 * Email + password login.
 *
 * Success path: the server sets the session cookie and returns
 * `{ user }`; we mirror that user into `useCurrentUserStore` so chrome
 * (TopBar / Members stack / etc.) has identity on first paint, then
 * navigate to the `?next=` query param if present (route guard set it
 * during the 401 bounce), otherwise to `/studio`.
 *
 * Failure path: server returns 401 with a generic message ("Invalid
 * email or password"). We surface that as a form-level FieldError
 * line above the submit button (role=alert) - not pinned to either
 * input, so we never leak which input is wrong, and not as a toast
 * because form errors belong with the form, not the global
 * cross-page notification surface.
 *
 * Google sign-in: shown when `GET /auth/options` says the server has it; the
 * button posts the page to Google and the callback brings it back here
 * (inner#2157).
 */

/**
 * Login page with the email/password form and optional Google sign-in.
 * @returns the login page with the email/password form and optional Google button.
 */
export default function LoginPage(): React.JSX.Element {
  const t = useTranslation();
  const [params] = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const registerPath = params.has('next')
    ? `/register?next=${encodeURIComponent(next)}`
    : '/register';
  const completeSignIn = useCompleteSignIn();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const arrival = useGoogleArrival();
  const referral = useSignupReferral(arrival.saved?.referral?.code);
  // The carried code is named on one row; once refused it is named as no longer valid (inner#1868 table 12.14).
  const [rowCode, setRowCode] = React.useState<string | null>(() => (arrival.saved?.referral?.typed ? null : referral.value || null));
  const [invalidCode, setInvalidCode] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(arrival.saved?.referral?.typed ?? false);
  const googleShown = useGoogleSignInShown();
  const googleError = useGoogleReturn(arrival, {
    destination: () => next,
    referral,
    onReferralInvalid: () => {
      referral.refused(t('auth.referral.invalid'));
      if (!expanded && rowCode !== null) {
        setInvalidCode(rowCode);
        setRowCode(null);
        referral.change('');
      }
    },
  });
  const pending = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Keep the referral state for the return from Google and report the start. */
  function leaveForGoogle(): void {
    saveGoogleStart({
      referral: referral.field === 'shown' ? { code: referral.value, typed: expanded } : null,
      query: keptQuery(params),
    });
    trackEvent('signup_started', { method: 'google' });
  }

  /** The visitor drops the carried code: the row folds to "Have a referral code?". */
  function removeCarried(): void {
    setRowCode(null);
    setInvalidCode(null);
    referral.change('');
    referral.used();
  }

  /**
   * The referral row above the Google button: only a new Google account uses it.
   * @returns The row for the current state, or null where nothing is sold (`selling` false).
   */
  function referralRow(): React.ReactNode {
    if (referral.field === 'loading') return <Skeleton data-testid='login-referral-loading' className='h-7 w-full' />;
    if (referral.field === 'hidden') return null;
    const named = invalidCode ?? rowCode;
    if (named !== null) {
      return (
        <div
          className={invalidCode !== null
            ? 'flex items-center justify-between rounded-chrome border border-status-error px-3 py-1.5 text-xs text-status-error'
            : 'flex items-center justify-between rounded-chrome bg-accent px-3 py-1.5 text-xs'}
        >
          <span>{renderSlottedText(invalidCode !== null
            ? t('auth.referral.carriedInvalid', { code: slotMarker('code') })
            : t('auth.referral.carried', { code: slotMarker('code') }), { code: <span className='font-semibold'>{named}</span> })}</span>
          <Button type='button' variant='ghost' size='compact' aria-label={t('auth.referral.remove')} onClick={removeCarried}>
            <X className='h-3.5 w-3.5' />
          </Button>
        </div>
      );
    }
    if (!expanded) {
      return (
        <Button type='button' variant='link' size='compact' className='w-fit px-0 text-xs text-muted-foreground' onClick={() => setExpanded(true)}>
          {t('auth.referral.haveCode')}
        </Button>
      );
    }
    return (
      <div className='flex flex-col gap-1'>
        <div className='flex items-baseline justify-between'>
          <Label htmlFor='login-referral'>{t('auth.referral.label')}</Label>
          <span className='text-xs text-muted-foreground'>{t('auth.referral.googleOnly')}</span>
        </div>
        <Input
          id='login-referral'
          autoComplete='off'
          maxLength={REFERRAL_CODE_INPUT_MAX}
          value={referral.value}
          placeholder={t('auth.referral.placeholder')}
          onChange={(e) => referral.change(e.target.value)}
          readOnly={submitting}
          aria-invalid={!!referral.error || undefined}
          aria-describedby={referral.error ? 'login-referral-error' : undefined}
        />
        {referral.error ? <FieldError id='login-referral-error'>{referral.error}</FieldError> : null}
      </div>
    );
  }
  // Field-level errors (inline below each input). `formError` is the
  // single async / server failure line that sits above the submit
  // button - kept out of toasts because form failures are tied to
  // this form, not the global cross-page notification surface.
  const [errors, setErrors] = React.useState<{
    email?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  /**
   * Validate the credentials client-side, then call the login API and
   * mirror the returned user into the store before navigating away.
   * @param e - the form submit event, prevented so the page does not reload
   */
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (pending.current) return;
    setFormError(null);
    const trimmedEmail = email.trim();
    const nextErrors: typeof errors = {};
    if (!looksLikeEmail(trimmedEmail)) {
      nextErrors.email = t('auth.invalidEmail');
    }
    if (password.length < 8) {
      nextErrors.password = t('auth.passwordTooShort');
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    pending.current = true;
    setSubmitting(true);
    try {
      const { user } = await authApi.login({ email: trimmedEmail, password });
      if (!mounted.current) return;
      completeSignIn(user, next);
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.login.failed');
      if (mounted.current) setFormError(message);
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <AuthCardShell
      showVersion
      title={t('auth.login.title')}
      notice={<TermsNotice />}
      subtitle={t('auth.login.subtitle')}
      footer={
        <>
          {t('auth.login.noAccount')}{' '}
          <AuthLink to={registerPath}>{t('auth.login.signUp')}</AuthLink>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className='flex flex-col gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='login-email'>{t('auth.email')}</Label>
          <Input
            id='login-email'
            type='email'
            autoComplete='email'
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (errors.email) setErrors((p) => ({ ...p, email: undefined }));
            }}
            readOnly={submitting}
            aria-invalid={!!errors.email || undefined}
            aria-describedby={errors.email ? 'login-email-error' : undefined}
          />
          {errors.email ? (
            <FieldError id='login-email-error'>{errors.email}</FieldError>
          ) : null}
        </div>

        <div className='flex flex-col gap-1'>
          <div className='flex items-center justify-between'>
            <Label htmlFor='login-password'>{t('auth.password')}</Label>
            <AuthLink to='/forgot-password'>
              {t('auth.login.forgotPassword')}
            </AuthLink>
          </div>
          <PasswordInput
            id='login-password'
            autoComplete='current-password'
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (errors.password) setErrors((p) => ({ ...p, password: undefined }));
            }}
            readOnly={submitting}
            aria-invalid={!!errors.password || undefined}
            aria-describedby={errors.password ? 'login-password-error' : undefined}
            showLabel={t('auth.passwordShow')}
            hideLabel={t('auth.passwordHide')}
          />
          {errors.password ? (
            <FieldError id='login-password-error'>{errors.password}</FieldError>
          ) : null}
        </div>

        {formError ? (
          <FieldError role='alert' className='mt-1'>{formError}</FieldError>
        ) : null}

        <Button type='submit' size='form' loading={submitting} className='mt-2'>
          {submitting ? t('auth.login.signingIn') : t('auth.login.signIn')}
        </Button>
      </form>

      {googleShown ? (
        <div className='mt-4 flex flex-col gap-3'>
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <div className='h-px flex-1 bg-border' />
            <span>{t('auth.or')}</span>
            <div className='h-px flex-1 bg-border' />
          </div>
          {referralRow()}
          {getDesktopBridge() ? (
            <DesktopGoogleSignIn referralCode={referral.value || null} next={next} busy={submitting} />
          ) : (
            <GoogleSignIn
              page='login'
              next={next}
              referral={referral.body()}
              disabled={submitting || referral.field === 'loading'}
              error={googleError}
              onLeave={leaveForGoogle}
            />
          )}
        </div>
      ) : null}
    </AuthCardShell>
  );
}
