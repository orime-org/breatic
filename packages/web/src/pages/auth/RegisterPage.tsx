// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { authApi, deriveDisplayName } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { PasswordInput } from '@web/components/ui/password-input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';
import { FieldError } from '@web/pages/auth/_shared/FieldError';

/**
 * Email + password registration — step one of the two-step sign-up.
 *
 * Flow:
 *   1. Submit registers (email + password only; no display name) + the
 *      server sets the session cookie. Response body returns
 *      `{ user, recoveryCode }`. At this point the account exists but
 *      has NO personal studio yet (`personalStudio === null`).
 *   2. We navigate to `/recovery-code` (carrying the code in nav state) to
 *      force the user to copy / download / acknowledge the one-time code.
 *   3. Continue redirects to the onboarding slug page
 *      (`/choose-slug`), step two, where the user picks a slug and
 *      the server creates their personal studio. The personal-studio
 *      gate in `ProtectedRoute` enforces this — a half-finished sign-up
 *      cannot reach the app proper.
 *
 * The recovery code is the ONLY recovery path on SMTP-less self-host
 * installs (`EMAIL_BACKEND=disabled`). The server only stores its
 * bcrypt hash — a missed save here is unrecoverable.
 * @returns the registration form; on success it navigates to the
 * recovery-code screen (`/recovery-code`).
 */
export default function RegisterPage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errors, setErrors] = React.useState<{
    email?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  /**
   * Validate the fields client-side, register the account, mirror the new
   * user into the store, and stash the returned recovery code to reveal.
   * @param e - the form submit event, prevented so the page does not reload
   */
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    const trimmedEmail = email.trim();
    const nextErrors: typeof errors = {};
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      nextErrors.email = t('auth.invalidEmail');
    }
    if (password.length < 8) nextErrors.password = t('auth.passwordTooShort');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const { user, recoveryCode: code } = await authApi.register({
        email: trimmedEmail,
        password,
      });
      // Step one creates the account with no personal studio yet — the
      // store mirrors that null so the onboarding gate is consistent
      // even before the recovery dialog is dismissed.
      setUser({
        id: user.id,
        email: user.email,
        name: deriveDisplayName({
          personalStudioName: user.personalStudio?.name ?? null,
          email: user.email,
        }),
        personalStudio: user.personalStudio,
      });
      navigate('/recovery-code', {
        state: { code, next: '/choose-slug' },
        replace: true,
      });
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.register.failed');
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <AuthCardShell
        title={t('auth.register.title')}
        subtitle={t('auth.register.subtitle')}
        footer={
          <>
            {t('auth.register.haveAccount')}{' '}
            <AuthLink to='/login'>{t('auth.register.signIn')}</AuthLink>
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
                setEmail(e.target.value);
                if (errors.email) setErrors((p) => ({ ...p, email: undefined }));
              }}
              disabled={submitting}
              aria-invalid={!!errors.email || undefined}
              aria-describedby={errors.email ? 'register-email-error' : undefined}
            />
            {errors.email ? (
              <FieldError id='register-email-error'>{errors.email}</FieldError>
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
              disabled={submitting}
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

          {formError ? (
            <FieldError role='alert' className='mt-1'>{formError}</FieldError>
          ) : null}

          <Button type='submit' size='form' disabled={submitting} className='mt-2'>
            {submitting
              ? t('auth.register.creating')
              : t('auth.register.create')}
          </Button>
        </form>
      </AuthCardShell>
    </>
  );
}
