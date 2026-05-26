import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { authApi } from '@/data/api/auth';
import { ApiException } from '@/data/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@/pages/auth/_shared/AuthCardShell';

/**
 * Forgot-password entry — dual-path UX:
 *
 *   - `email-link`     → POST /auth/forgot-password, server sends a
 *                        reset email (works only if EMAIL_BACKEND
 *                        is `smtp` or `console`; otherwise the user
 *                        sees the same generic "if your email is
 *                        registered…" message and nothing arrives).
 *   - `recovery-code`  → straight to /reset-password?mode=recovery,
 *                        where the user types the one-time code they
 *                        saved at registration.
 *
 * Why dual-path (vs probing backend EMAIL_BACKEND from JS):
 *   1. Whether email is enabled is a server-side configuration we'd
 *      rather not advertise in a public probe endpoint.
 *   2. Even when email IS enabled, some users will lose access to
 *      that mailbox; the recovery code is the always-available path.
 *   3. Putting the choice up-front matches Linear / 1Password "lost
 *      access" flows where users self-select the recovery channel.
 */
type Step = 'choose' | 'email-sent';

export default function ForgotPasswordPage() {
  const t = useTranslation();
  const navigate = useNavigate();

  const [step, setStep] = React.useState<Step>('choose');
  const [email, setEmail] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error(t('auth.invalidEmail'), { id: 'auth-feedback' });
      return;
    }
    setSubmitting(true);
    try {
      await authApi.forgotPassword({ email: trimmedEmail });
      setStep('email-sent');
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.forgot.failed');
      toast.error(message, { id: 'auth-feedback' });
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

  return (
    <AuthCardShell
      title={t('auth.forgot.title')}
      subtitle={t('auth.forgot.subtitle')}
      footer={<AuthLink to='/login'>{t('auth.forgot.backToSignIn')}</AuthLink>}
    >
      <form onSubmit={handleEmailSubmit} noValidate className='flex flex-col gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='forgot-email'>{t('auth.email')}</Label>
          <Input
            id='forgot-email'
            type='email'
            autoComplete='email'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </div>

        <Button type='submit' disabled={submitting} className='mt-2'>
          {submitting
            ? t('auth.forgot.sending')
            : t('auth.forgot.sendResetLink')}
        </Button>
      </form>

      <div className='mt-4 flex flex-col gap-2'>
        <div className='flex items-center gap-2 text-xs text-muted-foreground'>
          <div className='h-px flex-1 bg-border' />
          <span>{t('auth.or')}</span>
          <div className='h-px flex-1 bg-border' />
        </div>
        <Button
          type='button'
          variant='outline'
          onClick={() => navigate('/reset-password?mode=recovery')}
          className='w-full'
        >
          {t('auth.forgot.useRecoveryCode')}
        </Button>
      </div>
    </AuthCardShell>
  );
}
