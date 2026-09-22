// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getLocale } from '@breatic/shared';
import { GoogleSignIn } from '@web/pages/auth/GoogleSignIn';

import { authApi } from '@web/data/api/auth';
import { toCurrentUser, useCurrentUserStore } from '@web/stores/current-user';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { PasswordInput } from '@web/components/ui/password-input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';
import { FieldError } from '@web/pages/auth/_shared/FieldError';

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
 * Google OAuth: conditionally rendered if the frontend was built
 * with `GOOGLE_CLIENT_ID`. The id is injected at build time via
 * `__GOOGLE_CLIENT_ID__` (see `vite.config.mts`). Empty string =
 * not configured = hide the button entirely.
 */
declare const __GOOGLE_CLIENT_ID__: string;

/**
 * Login page with the email/password form and optional Google sign-in.
 * @returns the login page with the email/password form and optional Google button.
 */
export default function LoginPage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const pending = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /**
   * Exchange a Google-signed credential for the existing session cookie.
   * @param credential - The ID token supplied by Google's official SDK.
   * @throws {Error} Does not propagate errors; failures become form feedback.
   */
  async function handleGoogleCredential(credential: string): Promise<void> {
    if (pending.current || !mounted.current) return;
    pending.current = true;
    setSubmitting(true);
    setFormError(null);
    try {
      const { user } = await authApi.google({ credential });
      if (!mounted.current) return;
      setUser(toCurrentUser(user));
      navigate(params.get('next') ?? '/studio', { replace: true });
    } catch (err) {
      if (mounted.current) setFormError(err instanceof ApiException ? err.message : t('auth.login.failed'));
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
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
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
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
      setUser(toCurrentUser(user));
      navigate(params.get('next') ?? '/studio', { replace: true });
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.login.failed');
      if (mounted.current) setFormError(message);
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  const googleEnabled =
    typeof __GOOGLE_CLIENT_ID__ === 'string' && __GOOGLE_CLIENT_ID__ !== '';

  return (
    <AuthCardShell
      title={t('auth.login.title')}
      subtitle={t('auth.login.subtitle')}
      footer={
        <>
          {t('auth.login.noAccount')}{' '}
          <AuthLink to='/register'>{t('auth.login.signUp')}</AuthLink>
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
            disabled={submitting}
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
            disabled={submitting}
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

        <Button type='submit' size='form' disabled={submitting} className='mt-2'>
          {submitting ? t('auth.login.signingIn') : t('auth.login.signIn')}
        </Button>
      </form>

      {googleEnabled ? (
        <div className='mt-4 flex flex-col gap-3'>
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <div className='h-px flex-1 bg-border' />
            <span>{t('auth.or')}</span>
            <div className='h-px flex-1 bg-border' />
          </div>
          <GoogleSignIn key={getLocale()} clientId={__GOOGLE_CLIENT_ID__} busy={submitting} onCredential={handleGoogleCredential} />
        </div>
      ) : null}
    </AuthCardShell>
  );
}
