// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { authApi, type AuthUser, type SignupCodeSent } from '@web/data/api/auth';
import { toCurrentUser, useCurrentUserStore } from '@web/stores/current-user';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { PasswordInput } from '@web/components/ui/password-input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';
import { TermsNotice } from '@web/pages/auth/_shared/TermsNotice';
import { FieldError } from '@web/pages/auth/_shared/FieldError';
import { SignupCodeStep } from '@web/pages/auth/SignupCodeStep';

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
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errors, setErrors] = React.useState<{
    email?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [codeSent, setCodeSent] = React.useState<SignupCodeSent | null>(null);

  /**
   * Send the form's email and password and follow the answer.
   * @param trimmedEmail - the address as submitted
   * @returns the code-sent answer, or `null` when the sign-up went another way
   *   (created, or refused — the refusal is shown on the form)
   */
  const register = React.useCallback(
    async (trimmedEmail: string): Promise<SignupCodeSent | null> => {
      try {
        const answer = await authApi.register({ email: trimmedEmail, password });
        if (answer.status === 'code_sent') {
          setCodeSent(answer);
          return answer;
        }
        // Step one creates the account with no personal studio yet — the
        // store mirrors that null so the onboarding gate is consistent
        // even before the recovery dialog is dismissed.
        setUser(toCurrentUser(answer.user));
        navigate('/recovery-code', {
          state: { code: answer.recoveryCode, next: '/choose-slug' },
          replace: true,
        });
        return null;
      } catch (err) {
        setCodeSent(null);
        setFormError(err instanceof ApiException ? err.message : t('auth.register.failed'));
        return null;
      }
    },
    [password, setUser, navigate, t],
  );

  const restart = React.useCallback(
    (): Promise<SignupCodeSent | null> => register(email.trim()),
    [register, email],
  );

  const handleVerified = React.useCallback(
    (user: AuthUser): void => {
      setUser(toCurrentUser(user));
      navigate('/choose-slug', { replace: true });
    },
    [setUser, navigate],
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
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      nextErrors.email = t('auth.invalidEmail');
    }
    if (password.length < 8) nextErrors.password = t('auth.passwordTooShort');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      await register(trimmedEmail);
    } finally {
      setSubmitting(false);
    }
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
        title={t('auth.register.title')}
        notice={<TermsNotice />}
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
