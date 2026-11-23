// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SHA256_BASE64URL, desktopSignInReturn } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { authApi } from '@web/data/api/auth';
import { AUTH_OPTIONS_QUERY_KEY } from '@web/features/referral/use-signup-referral';
import { useTranslation } from '@web/i18n/use-translation';
import { useCurrentUserStore } from '@web/stores/current-user';
import { AuthCardShell } from '@web/pages/auth/_shared/AuthCardShell';


type Stage = 'confirm' | 'processing' | 'handed' | 'error';

interface DesktopSignInPageProps {
  /** Opens the link to the desktop client; the browser's own navigation unless a test replaces it. */
  openLink?: (href: string) => void;
}

/**
 * Follow a link to the desktop client.
 * @param href - The link on the desktop app's scheme.
 */
function navigateTo(href: string): void {
  window.location.href = href;
}

/**
 * The browser side of the desktop client's sign-in (#1599). Signed in already
 * (the route sits behind ProtectedRoute), the user confirms the account; only
 * then is a code asked for, so a program that opens this page cannot take the
 * account on its own (RFC 8252 §8.6). The code goes back through
 * `{scheme}://sign-in` with the challenge, which the client matches against
 * the sign-in it is waiting for. The scheme and the app's name are this
 * deployment's settings (`/auth/options`): nothing in the address changes
 * them, and until they arrive nothing can be handed over (design §8.3).
 * @param props - How to open the link.
 * @param props.openLink - Opens the link on the desktop app's scheme.
 * @returns The confirm, processing, handed-back or error card.
 */
export function DesktopSignInView({ openLink = navigateTo }: DesktopSignInPageProps): React.JSX.Element {
  const t = useTranslation();
  const [params] = useSearchParams();
  const challenge = params.get('challenge') ?? '';
  const valid = SHA256_BASE64URL.test(challenge);
  const email = useCurrentUserStore((s) => s.user?.email ?? '');
  const clear = useCurrentUserStore((s) => s.clear);
  const [stage, setStage] = React.useState<Stage>(valid ? 'confirm' : 'error');
  const [link, setLink] = React.useState<string | null>(null);
  const options = useQuery({ queryKey: AUTH_OPTIONS_QUERY_KEY, queryFn: () => authApi.options(), retry: false });
  const scheme = options.data?.desktopAppScheme;
  const app = options.data?.desktopAppName ?? '';

  /** Ask for a code and hand it to the client. */
  async function handOff(): Promise<void> {
    if (!scheme) return;
    setStage('processing');
    try {
      const { code } = await authApi.desktopHandoff({ challenge });
      const href = desktopSignInReturn(scheme, code, challenge);
      setLink(href);
      openLink(href);
      setStage('handed');
    } catch {
      setStage('error');
    }
  }

  /** Sign out of this browser; ProtectedRoute then takes the user to sign in again and back here. */
  async function switchAccount(): Promise<void> {
    try {
      await authApi.logout();
    } finally {
      clear();
    }
  }

  if (stage === 'handed' && link) {
    return (
      <AuthCardShell title={t('auth.desktop.handedTitle', { app })} subtitle={t('auth.desktop.handedBody')}>
        <Button type='button' className='w-full' onClick={() => openLink(link)}>
          {t('auth.desktop.openApp', { app })}
        </Button>
      </AuthCardShell>
    );
  }

  if (stage === 'error' || options.isError || (options.isSuccess && !scheme)) {
    return (
      <AuthCardShell title={t('auth.desktop.errorTitle')} subtitle={t('auth.desktop.errorBody')}>
        {valid ? (
          <Button
            type='button'
            variant='outline'
            className='w-full'
            loading={options.isFetching}
            onClick={() => (options.isError ? void options.refetch() : setStage('confirm'))}
          >
            {t('auth.desktop.retry')}
          </Button>
        ) : null}
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell title={t('auth.desktop.title', { app })} subtitle={t('auth.desktop.signingInAs', { email })}>
      <div className='flex flex-col gap-3'>
        <Button type='button' className='w-full' loading={stage === 'processing'} disabled={!scheme} onClick={() => void handOff()}>
          {t('auth.desktop.continue')}
        </Button>
        <Button type='button' variant='outline' className='w-full' disabled={stage === 'processing'} onClick={() => void switchAccount()}>
          {t('auth.desktop.switchAccount')}
        </Button>
      </div>
    </AuthCardShell>
  );
}

/**
 * The `/desktop/sign-in` route.
 * @returns The page, opening the link with the browser's own navigation.
 */
export default function DesktopSignInPage(): React.JSX.Element {
  return <DesktopSignInView />;
}
