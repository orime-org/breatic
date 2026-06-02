import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { PasswordInput } from '@web/components/ui/password-input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';
import { FieldError } from '@web/pages/auth/_shared/FieldError';
import { RecoveryCodeDialog } from '@web/pages/auth/_shared/RecoveryCodeDialog';

/**
 * Password reset — branches on the query string:
 *
 *   `?token=xxx`        → email-link reset (server-issued token
 *                         delivered in the password-reset email).
 *   `?mode=recovery`    → recovery-code reset (user typed the
 *                         one-time code they saved at registration).
 *                         Server rotates the code on success and
 *                         returns a fresh one, which we re-reveal in
 *                         the same `<RecoveryCodeDialog>` flow.
 *
 * Neither path requires the user to be logged in — the token or
 * code IS the auth.
 */
type Mode = 'token' | 'recovery';

/**
 * Reset-password page: the token reset form when `?token=` is present, else
 * the recovery-code reset form.
 * @returns the token-based reset form when `?token=` is present, otherwise
 * the recovery-code reset form.
 */
export default function ResetPasswordPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const tokenFromQuery = params.get('token');
  const mode: Mode = tokenFromQuery ? 'token' : 'recovery';

  if (mode === 'token') {
    return <TokenResetForm token={tokenFromQuery!} onSuccess={() => navigate('/login', { replace: true })} />;
  }
  return <RecoveryResetForm />;
}

/**
 * Email-link reset form — sets a new password using a server-issued token.
 * @param root0 - component props
 * @param root0.token - the password-reset token delivered in the reset email
 * @param root0.onSuccess - called after the password is successfully reset
 * @returns the new-password form for the token reset path.
 */
function TokenResetForm({
  token,
  onSuccess,
}: {
  token: string;
  onSuccess: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  /**
   * Validate the new password, submit it with the token, and invoke
   * `onSuccess` (redirect to login) when the reset completes.
   * @param e - the form submit event, prevented so the page does not reload
   */
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    if (password.length < 8) {
      setPasswordError(t('auth.passwordTooShort'));
      return;
    }
    setPasswordError(null);
    setSubmitting(true);
    try {
      await authApi.resetPasswordWithToken({ token, password });
      toast.success(t('auth.reset.success'), { id: 'auth-feedback' });
      onSuccess();
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.reset.failed');
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCardShell
      title={t('auth.reset.titleToken')}
      subtitle={t('auth.reset.subtitleToken')}
      footer={<AuthLink to='/login'>{t('auth.reset.backToSignIn')}</AuthLink>}
    >
      <form onSubmit={handleSubmit} noValidate className='flex flex-col gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='reset-password'>{t('auth.reset.newPassword')}</Label>
          <PasswordInput
            id='reset-password'
            autoComplete='new-password'
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (passwordError) setPasswordError(null);
            }}
            disabled={submitting}
            aria-invalid={!!passwordError || undefined}
            aria-describedby={passwordError ? 'reset-password-error' : undefined}
            showLabel={t('auth.passwordShow')}
            hideLabel={t('auth.passwordHide')}
          />
          {passwordError ? (
            <FieldError id='reset-password-error'>{passwordError}</FieldError>
          ) : null}
        </div>

        {formError ? (
          <FieldError role='alert' className='mt-1'>{formError}</FieldError>
        ) : null}

        <Button type='submit' disabled={submitting} className='mt-2'>
          {submitting ? t('auth.reset.saving') : t('auth.reset.save')}
        </Button>
      </form>
    </AuthCardShell>
  );
}

/**
 * Recovery-code reset form — sets a new password using the email plus the
 * one-time recovery code, then re-reveals the rotated code.
 * @returns the recovery-code reset form, or the rotated-code reveal dialog
 * once the reset has succeeded.
 */
function RecoveryResetForm(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = React.useState('');
  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [newCode, setNewCode] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<{
    email?: string;
    recoveryCode?: string;
    newPassword?: string;
  }>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  /**
   * Validate the email, recovery code, and new password, submit them, and
   * stash the rotated recovery code returned by the server to reveal.
   * @param e - the form submit event, prevented so the page does not reload
   */
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    const trimmedEmail = email.trim();
    const trimmedCode = recoveryCode.trim();
    const nextErrors: typeof errors = {};
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      nextErrors.email = t('auth.invalidEmail');
    }
    if (!trimmedCode) nextErrors.recoveryCode = t('auth.reset.recoveryCodeRequired');
    if (newPassword.length < 8) nextErrors.newPassword = t('auth.passwordTooShort');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const { newRecoveryCode } = await authApi.resetPasswordWithRecoveryCode({
        email: trimmedEmail,
        recoveryCode: trimmedCode,
        newPassword,
      });
      setNewCode(newRecoveryCode);
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.reset.failed');
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Dismiss the rotated-code dialog and navigate to login once the user has
   * acknowledged saving their new recovery code.
   */
  function handleContinue(): void {
    setNewCode(null);
    navigate('/login', { replace: true });
  }

  // Once the recovery-code reset succeeds we have a fresh recovery
  // code to reveal — unmount the form for the same reasons as
  // RegisterPage (overlay is semi-transparent, residual form would
  // show through; single-task-at-a-time UX).
  if (newCode !== null) {
    return (
      <RecoveryCodeDialog
        open={true}
        code={newCode}
        onContinue={handleContinue}
      />
    );
  }

  return (
    <>
      <AuthCardShell
        title={t('auth.reset.titleRecovery')}
        subtitle={t('auth.reset.subtitleRecovery')}
        footer={<AuthLink to='/login'>{t('auth.reset.backToSignIn')}</AuthLink>}
      >
        <form onSubmit={handleSubmit} noValidate className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='recovery-email'>{t('auth.email')}</Label>
            <Input
              id='recovery-email'
              type='email'
              autoComplete='email'
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errors.email) setErrors((p) => ({ ...p, email: undefined }));
              }}
              disabled={submitting}
              aria-invalid={!!errors.email || undefined}
              aria-describedby={errors.email ? 'recovery-email-error' : undefined}
            />
            {errors.email ? (
              <FieldError id='recovery-email-error'>{errors.email}</FieldError>
            ) : null}
          </div>

          <div className='flex flex-col gap-1'>
            <Label htmlFor='recovery-code'>{t('auth.reset.recoveryCode')}</Label>
            <Input
              id='recovery-code'
              type='text'
              autoComplete='off'
              placeholder='XXXX-XXXX-XXXX-XXXX'
              value={recoveryCode}
              onChange={(e) => {
                setRecoveryCode(e.target.value.toUpperCase());
                if (errors.recoveryCode) setErrors((p) => ({ ...p, recoveryCode: undefined }));
              }}
              disabled={submitting}
              aria-invalid={!!errors.recoveryCode || undefined}
              aria-describedby={errors.recoveryCode ? 'recovery-code-error' : undefined}
              className='font-mono tracking-wider'
            />
            {errors.recoveryCode ? (
              <FieldError id='recovery-code-error'>{errors.recoveryCode}</FieldError>
            ) : null}
          </div>

          <div className='flex flex-col gap-1'>
            <Label htmlFor='recovery-new-password'>
              {t('auth.reset.newPassword')}
            </Label>
            <PasswordInput
              id='recovery-new-password'
              autoComplete='new-password'
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                if (errors.newPassword) setErrors((p) => ({ ...p, newPassword: undefined }));
              }}
              disabled={submitting}
              aria-invalid={!!errors.newPassword || undefined}
              aria-describedby={errors.newPassword ? 'recovery-new-password-error' : undefined}
              showLabel={t('auth.passwordShow')}
              hideLabel={t('auth.passwordHide')}
            />
            {errors.newPassword ? (
              <FieldError id='recovery-new-password-error'>{errors.newPassword}</FieldError>
            ) : null}
          </div>

          {formError ? (
            <FieldError role='alert' className='mt-1'>{formError}</FieldError>
          ) : null}

          <Button type='submit' disabled={submitting} className='mt-2'>
            {submitting ? t('auth.reset.saving') : t('auth.reset.save')}
          </Button>
        </form>
      </AuthCardShell>
    </>
  );
}
