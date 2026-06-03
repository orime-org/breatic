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
import { RecoveryCodeDialog } from '@web/pages/auth/_shared/RecoveryCodeDialog';

/**
 * Email + password registration.
 *
 * Two-step flow:
 *   1. Submit registers + the server sets the session cookie. Response
 *      body returns `{ user, recoveryCode }`.
 *   2. We pop `<RecoveryCodeDialog>` to force the user to copy /
 *      download / acknowledge the one-time recovery code before
 *      proceeding. Continue redirects to `/studio`.
 *
 * The recovery code is the ONLY recovery path on SMTP-less self-host
 * installs (`EMAIL_BACKEND=disabled`). The server only stores its
 * bcrypt hash — a missed save here is unrecoverable.
 * @returns the registration form, or the recovery-code reveal dialog once
 * registration has succeeded.
 */
export default function RegisterPage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [name, setName] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [recoveryCode, setRecoveryCode] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<{
    name?: string;
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
    const trimmedName = name.trim();
    const nextErrors: typeof errors = {};
    if (!trimmedName) nextErrors.name = t('auth.nameRequired');
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
        name: trimmedName,
      });
      setUser({
        id: user.id,
        email: user.email,
        name: deriveDisplayName(user),
      });
      setRecoveryCode(code);
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.register.failed');
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Dismiss the recovery-code dialog and navigate to the studio after the
   * user has acknowledged saving their code.
   */
  function handleContinue(): void {
    setRecoveryCode(null);
    navigate('/studio', { replace: true });
  }

  // Once registration succeeds we have a recovery code to reveal —
  // unmount the registration form entirely instead of leaving it
  // visible behind the dialog overlay. Dialog overlay is semi-
  // transparent, so a residual form would show through; conditional
  // render keeps the focus where it belongs and matches the
  // single-task-at-a-time UX user spec called for.
  if (recoveryCode !== null) {
    return (
      <RecoveryCodeDialog
        open={true}
        code={recoveryCode}
        onContinue={handleContinue}
      />
    );
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
            <Label htmlFor='register-name'>{t('auth.name')}</Label>
            <Input
              id='register-name'
              type='text'
              autoComplete='name'
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
              }}
              disabled={submitting}
              aria-invalid={!!errors.name || undefined}
              aria-describedby={errors.name ? 'register-name-error' : undefined}
            />
            {errors.name ? (
              <FieldError id='register-name-error'>{errors.name}</FieldError>
            ) : null}
          </div>

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

          <Button type='submit' disabled={submitting} className='mt-2'>
            {submitting
              ? t('auth.register.creating')
              : t('auth.register.create')}
          </Button>
        </form>
      </AuthCardShell>
    </>
  );
}
