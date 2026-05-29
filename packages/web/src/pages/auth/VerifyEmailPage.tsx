import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';

/**
 * Email verification landing — user lands here from the verify-email
 * link in their inbox: `/verify-email?token=xxx`.
 *
 * On mount we POST the token to `/auth/verify-email`; the server
 * single-uses the token, flips `email_verified`, and 200s. Failure
 * (invalid / expired / already-consumed) surfaces a soft "ask for a
 * fresh link" state — no toast spam, no infinite retry.
 *
 * Missing `?token=` shows the same instructional state ("check your
 * inbox") instead of a hard error, since plain visits to
 * `/verify-email` should give the user something useful to do.
 */
type Status = 'verifying' | 'success' | 'failed' | 'no-token';

export default function VerifyEmailPage() {
  const t = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');

  const [status, setStatus] = React.useState<Status>(
    token ? 'verifying' : 'no-token',
  );
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        await authApi.verifyEmail({ token });
        if (!cancelled) setStatus('success');
      } catch (err) {
        if (cancelled) return;
        setStatus('failed');
        setErrorMessage(
          err instanceof ApiException ? err.message : t('auth.verify.failed'),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  if (status === 'verifying') {
    return (
      <AuthCardShell title={t('auth.verify.verifying')}>
        <div className='flex items-center justify-center gap-3 py-4 text-muted-foreground'>
          <Loader2 className='h-5 w-5 animate-spin' aria-hidden />
          <span className='text-sm'>{t('auth.verify.pleaseWait')}</span>
        </div>
      </AuthCardShell>
    );
  }

  if (status === 'success') {
    return (
      <AuthCardShell title={t('auth.verify.successTitle')}>
        <p className='text-sm text-muted-foreground'>
          {t('auth.verify.successBody')}
        </p>
        <Button
          type='button'
          className='mt-4 w-full'
          onClick={() => navigate('/studio', { replace: true })}
        >
          {t('auth.verify.goToStudio')}
        </Button>
      </AuthCardShell>
    );
  }

  if (status === 'failed') {
    return (
      <AuthCardShell
        title={t('auth.verify.failedTitle')}
        subtitle={errorMessage ?? undefined}
        footer={<AuthLink to='/login'>{t('auth.verify.signIn')}</AuthLink>}
      >
        <p className='text-sm text-muted-foreground'>
          {t('auth.verify.failedBody')}
        </p>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={t('auth.verify.checkInboxTitle')}
      footer={<AuthLink to='/login'>{t('auth.verify.signIn')}</AuthLink>}
    >
      <p className='text-sm text-muted-foreground'>
        {t('auth.verify.checkInboxBody')}
      </p>
    </AuthCardShell>
  );
}
