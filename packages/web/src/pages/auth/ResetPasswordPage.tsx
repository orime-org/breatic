import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { authApi } from '@/data/api/auth';
import { ApiException } from '@/data/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@/pages/auth/_shared/AuthCardShell';
import { RecoveryCodeDialog } from '@/pages/auth/_shared/RecoveryCodeDialog';

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

export default function ResetPasswordPage() {
  const t = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const tokenFromQuery = params.get('token');
  const mode: Mode = tokenFromQuery ? 'token' : 'recovery';

  if (mode === 'token') {
    return <TokenResetForm token={tokenFromQuery!} onSuccess={() => navigate('/login', { replace: true })} />;
  }
  return <RecoveryResetForm />;
}

function TokenResetForm({
  token,
  onSuccess,
}: {
  token: string;
  onSuccess: () => void;
}) {
  const t = useTranslation();
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await authApi.resetPasswordWithToken({ token, password });
      toast.success(t('auth.reset.success'), { id: 'auth-feedback' });
      onSuccess();
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.reset.failed');
      toast.error(message, { id: 'auth-feedback' });
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
          <Input
            id='reset-password'
            type='password'
            autoComplete='new-password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </div>

        <Button type='submit' disabled={submitting} className='mt-2'>
          {submitting ? t('auth.reset.saving') : t('auth.reset.save')}
        </Button>
      </form>
    </AuthCardShell>
  );
}

function RecoveryResetForm() {
  const t = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = React.useState('');
  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [newCode, setNewCode] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const { newRecoveryCode } = await authApi.resetPasswordWithRecoveryCode({
        email,
        recoveryCode,
        newPassword,
      });
      setNewCode(newRecoveryCode);
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.reset.failed');
      toast.error(message, { id: 'auth-feedback' });
    } finally {
      setSubmitting(false);
    }
  }

  function handleContinue() {
    setNewCode(null);
    navigate('/login', { replace: true });
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
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className='flex flex-col gap-1'>
            <Label htmlFor='recovery-code'>{t('auth.reset.recoveryCode')}</Label>
            <Input
              id='recovery-code'
              type='text'
              autoComplete='off'
              placeholder='XXXX-XXXX-XXXX-XXXX'
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
              disabled={submitting}
              className='font-mono tracking-wider'
            />
          </div>

          <div className='flex flex-col gap-1'>
            <Label htmlFor='recovery-new-password'>
              {t('auth.reset.newPassword')}
            </Label>
            <Input
              id='recovery-new-password'
              type='password'
              autoComplete='new-password'
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
            />
          </div>

          <Button type='submit' disabled={submitting} className='mt-2'>
            {submitting ? t('auth.reset.saving') : t('auth.reset.save')}
          </Button>
        </form>
      </AuthCardShell>

      <RecoveryCodeDialog
        open={newCode !== null}
        code={newCode ?? ''}
        onContinue={handleContinue}
      />
    </>
  );
}
