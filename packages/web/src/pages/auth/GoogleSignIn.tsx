// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { configuredErrorEventId } from '@web/lib/error-monitoring';
import { ErrorBoundary, type Scope, type FallbackRender } from '@sentry/react';
import { GoogleLogin, GoogleOAuthProvider } from '@react-oauth/google';
import { getLocale } from '@breatic/shared';
import { useTranslation } from '@web/i18n/use-translation';
import { FieldError } from '@web/pages/auth/_shared/FieldError';

interface GoogleSignInProps {
  clientId: string;
  busy: boolean;
  onCredential: (credential: string) => Promise<void>;
}

/**
 * Render Google's official button with the approved contrasting theme and the login card's width.
 * @param props - Button configuration and submission state.
 * @param props.clientId - Public Google Web application identifier.
 * @param props.busy - Whether either login method is submitting.
 * @param props.onCredential - Exchange the Google credential for a session.
 * @returns The Google-owned button and local loading/error feedback.
 * @throws {Error} If React cannot render the component.
 */
function GoogleSignInButton({ clientId, busy, onCredential }: GoogleSignInProps): React.JSX.Element {
  const t = useTranslation();
  const container = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(334);
  const [dark, setDark] = React.useState(document.documentElement.dataset.theme === 'dark');
  // Google supports outline_dark; @react-oauth/google 0.13.5 types lag the SDK.
  // https://developers.google.com/identity/gsi/web/reference/js-reference#theme
  const googleTheme = (dark ? 'outline' : 'outline_dark') as React.ComponentProps<typeof GoogleLogin>['theme'];
  const [script, setScript] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [credentialError, setCredentialError] = React.useState(false);

  React.useEffect(() => {
    if (script !== 'loading') return;
    // The status-specific timer is cancelled as soon as the script loads.
    const timeout = window.setTimeout(() => setScript('failed'), 15_000);
    return () => window.clearTimeout(timeout);
  }, [script]);

  React.useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    /**
     * Measure the space Google may occupy without restyling its iframe.
     * @throws {Error} If the browser cannot measure the element.
     */
    const measure = (): void => { setWidth(Math.min(400, Math.max(200, Math.floor(element.getBoundingClientRect().width) || 334))); };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const theme = new MutationObserver(() => setDark(document.documentElement.dataset.theme === 'dark'));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { resize.disconnect(); theme.disconnect(); };
  }, []);

  return (
    <div ref={container} className='flex flex-col gap-2'>
      <GoogleOAuthProvider
        clientId={clientId}
        locale={getLocale()}
        onScriptLoadSuccess={() => setScript('ready')}
        onScriptLoadError={() => setScript('failed')}
      >
        {/* Match Google's iframe canvas scheme so its extra margins stay transparent in dark mode. */}
        <div inert={busy || script !== 'ready'} aria-busy={busy} className={script === 'failed' ? 'hidden' : 'scheme-light min-h-10'}>
          <GoogleLogin
            theme={googleTheme}
            size='large'
            shape='pill'
            text='continue_with'
            logo_alignment='left'
            width={width}
            ux_mode='popup'
            auto_select={false}
            useOneTap={false}
            onSuccess={({ credential }) => {
              if (!credential || script !== 'ready') return;
              setCredentialError(false);
              void onCredential(credential);
            }}
            onError={() => setCredentialError(true)}
          />
        </div>
      </GoogleOAuthProvider>
      {script === 'loading' ? <p role='status' className='text-sm text-muted-foreground'>{t('auth.login.googleLoading')}</p> : null}
      {script === 'failed' || credentialError ? <FieldError role='alert' className='text-center'>{t('auth.login.googleFailed')}</FieldError> : null}
    </div>
  );
}

/**
 * Tag third-party button errors without attaching credentials or form values.
 * @param scope - The SDK's isolated capture scope.
 * @throws {Error} If the SDK cannot annotate the event.
 */
function tagGoogleError(scope: Scope): void {
  scope.setTag('error_boundary', 'google-sign-in');
}

/**
 * Explain the remaining email path after the Google subtree has failed.
 * @param props - Optional monitoring reference for this button failure.
 * @param props.eventId - Identifier returned by a configured client.
 * @returns Localized inline feedback.
 * @throws {Error} If React cannot render feedback.
 */
function GoogleSignInFailure({ eventId }: { eventId?: string }): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex flex-col gap-2'>
      <FieldError role='alert' className='text-center'>{t('auth.login.googleFailed')}</FieldError>
      {eventId ? <p className='break-all text-center text-xs text-muted-foreground'>{t('applicationError.reference', { id: eventId })}</p> : null}
    </div>
  );
}

/**
 * Render only the Google failure; the neighboring email form stays mounted.
 * @param report - The captured SDK report.
 * @param report.eventId - Identifier associated with this error.
 * @returns Inline failure feedback.
 * @throws {Error} If React cannot render feedback.
 */
const renderGoogleFailure: FallbackRender = ({ eventId }): React.JSX.Element => (
  <GoogleSignInFailure eventId={configuredErrorEventId(eventId)} />
);

/**
 * Isolate Google's render/effect lifecycle from the email sign-in form.
 * @param props - Existing Google button configuration and credential callback.
 * @returns A button or inline failure, with one Sentry capture per failure.
 * @throws {Error} If the failure feedback itself fails to render.
 */
export function GoogleSignIn(props: GoogleSignInProps): React.JSX.Element {
  return (
    <ErrorBoundary beforeCapture={tagGoogleError} fallback={renderGoogleFailure}>
      <GoogleSignInButton {...props} />
    </ErrorBoundary>
  );
}
