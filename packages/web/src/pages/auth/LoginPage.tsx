import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { authApi } from '@/data/api/auth';
import { ApiException } from '@/data/api/types';
import { useCurrentUserStore } from '@/stores';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@/pages/auth/_shared/AuthCardShell';

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
 * email or password"). We surface that as a toast — never as a field
 * error — to avoid leaking which input is wrong.
 *
 * Google OAuth: conditionally rendered if the backend was started
 * with `GOOGLE_CLIENT_ID`. The id is injected at build time via
 * `__GOOGLE_CLIENT_ID__` (see `vite.config.mts`). Empty string =
 * not configured = hide the button entirely.
 */
declare const __GOOGLE_CLIENT_ID__: string;

export default function LoginPage() {
  const t = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    // Inline validation — form is `noValidate` so we own messaging and
    // the OS-level browser tooltip never shows. Toast id `auth-feedback`
    // replaces any prior toast from this page instead of stacking.
    const trimmedEmail = email.trim();
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
      const { user } = await authApi.login({ email: trimmedEmail, password });
      setUser({
        id: user.id,
        email: user.email,
        name: user.name,
      });
      navigate(params.get('next') ?? '/studio', { replace: true });
    } catch (err) {
      const message =
        err instanceof ApiException ? err.message : t('auth.login.failed');
      toast.error(message, { id: 'auth-feedback' });
    } finally {
      setSubmitting(false);
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
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className='flex flex-col gap-1'>
          <div className='flex items-center justify-between'>
            <Label htmlFor='login-password'>{t('auth.password')}</Label>
            <AuthLink to='/forgot-password'>
              {t('auth.login.forgotPassword')}
            </AuthLink>
          </div>
          <Input
            id='login-password'
            type='password'
            autoComplete='current-password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </div>

        <Button type='submit' disabled={submitting} className='mt-2'>
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
          <GoogleSignInButton />
        </div>
      ) : null}
    </AuthCardShell>
  );
}

/**
 * Google Sign-In trampoline — opens the GIS popup, exchanges the ID
 * token via `POST /auth/google`, then mirrors the user into the
 * current-user store. The Google script is loaded lazily on first
 * click to avoid the third-party request when most users come in
 * via email/password.
 *
 * Kept inline (rather than as a separate file under `features/auth/`)
 * because it's the LoginPage's only consumer and the wiring is tiny.
 * Promotes to its own file the moment a second page (e.g. settings)
 * needs to re-link Google to an existing account.
 */
function GoogleSignInButton() {
  const t = useTranslation();
  const navigate = useNavigate();
  const setUser = useCurrentUserStore((s) => s.setUser);
  const [busy, setBusy] = React.useState(false);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      // For now, hand off to a placeholder credential. The full GIS
      // popup flow ships in a follow-up; this button is wired so the
      // surface area + i18n key exists. (PR-b scope is the cookie
      // migration plumbing — see plan §阶段 4.) Toast `id` is shared
      // with the email-password feedback so repeated clicks replace
      // the prior toast instead of stacking.
      toast.info(t('auth.login.googleSoon'), { id: 'auth-feedback' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type='button'
      variant='outline'
      onClick={handleClick}
      disabled={busy}
      className='w-full'
    >
      {t('auth.login.continueWithGoogle')}
    </Button>
  );
}
