import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { authApi } from '@/data/api/auth';
import { ApiException } from '@/data/api/types';
import { useCurrentUserStore } from '@/stores';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@/pages/auth/_shared/AuthCardShell';
import { RecoveryCodeDialog } from '@/pages/auth/_shared/RecoveryCodeDialog';

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
 */
export default function RegisterPage() {
  const t = useTranslation();
  const navigate = useNavigate();
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [name, setName] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [recoveryCode, setRecoveryCode] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmedEmail = email.trim();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('auth.nameRequired'), { id: 'auth-feedback' });
      return;
    }
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error(t('auth.invalidEmail'), { id: 'auth-feedback' });
      return;
    }
    if (password.length < 8) {
      toast.error(t('auth.passwordTooShort'), { id: 'auth-feedback' });
      return;
    }
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
        name: user.name,
      });
      setRecoveryCode(code);
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.register.failed');
      toast.error(message, { id: 'auth-feedback' });
    } finally {
      setSubmitting(false);
    }
  }

  function handleContinue() {
    // Clear the code from React state before navigating so the only
    // copy in memory dies with this component's unmount.
    setRecoveryCode(null);
    navigate('/studio', { replace: true });
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
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className='flex flex-col gap-1'>
            <Label htmlFor='register-email'>{t('auth.email')}</Label>
            <Input
              id='register-email'
              type='email'
              autoComplete='email'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className='flex flex-col gap-1'>
            <Label htmlFor='register-password'>{t('auth.password')}</Label>
            <Input
              id='register-password'
              type='password'
              autoComplete='new-password'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
            <p className='text-xs text-muted-foreground'>
              {t('auth.register.passwordHint')}
            </p>
          </div>

          <Button type='submit' disabled={submitting} className='mt-2'>
            {submitting
              ? t('auth.register.creating')
              : t('auth.register.create')}
          </Button>
        </form>
      </AuthCardShell>

      <RecoveryCodeDialog
        open={recoveryCode !== null}
        code={recoveryCode ?? ''}
        onContinue={handleContinue}
      />
    </>
  );
}
