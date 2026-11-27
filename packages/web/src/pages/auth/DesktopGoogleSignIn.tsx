// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { Button } from '@web/components/ui/button';
import { authApi } from '@web/data/api/auth';
import { useTranslation } from '@web/i18n/use-translation';
import { getDesktopBridge } from '@web/lib/desktop-bridge';
import { toast } from '@web/lib/toast';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useCompleteSignIn } from '@web/pages/auth/use-complete-sign-in';
import { GOOGLE_BUTTON_CLASS, GOOGLE_MARK_CLASS, GoogleMark } from '@web/pages/auth/GoogleMark';

interface DesktopGoogleSignInProps {
  /** The referral code the page carries, handed to the browser's sign-up. */
  referralCode: string | null;
  /** Where the sign-in goes when it finishes. */
  next: string;
  /** Another sign-in on the page is in flight. */
  busy: boolean;
}

/**
 * Google sign-in inside the desktop client (inner#2041). Google refuses sign-in in
 * an embedded page, so the button opens the system browser and waits for the
 * code it hands back. The wait lives in the client, so a reload or a move to
 * the register page picks it up again on mount.
 * @param props - The carried referral code, the destination and the page's busy state.
 * @param props.referralCode - The referral code the page carries.
 * @param props.next - Where the sign-in goes when it finishes.
 * @param props.busy - Another sign-in on the page is in flight.
 * @returns The button, or the wait with its cancel; nothing outside the client.
 */
export function DesktopGoogleSignIn({ referralCode, next, busy }: DesktopGoogleSignInProps): React.JSX.Element | null {
  const t = useTranslation();
  const bridge = React.useMemo(getDesktopBridge, []);
  const completeSignIn = useCompleteSignIn();
  const [waiting, setWaiting] = React.useState(false);
  const [exchanging, setExchanging] = React.useState(false);
  const mounted = React.useRef(true);
  const failedText = t('auth.desktop.exchangeFailed');

  const redeem = React.useCallback(async (): Promise<void> => {
    if (!bridge) return;
    const result = await bridge.takeBrowserSignInResult();
    if (!result || !mounted.current) return;
    setExchanging(true);
    try {
      const { user } = await authApi.desktopExchange(result);
      if (mounted.current) completeSignIn(user, next);
    } catch {
      toast.error(failedText);
      if (mounted.current) setWaiting(false);
    } finally {
      if (mounted.current) setExchanging(false);
    }
  }, [bridge, completeSignIn, next, failedText]);

  React.useEffect(() => {
    if (!bridge) return;
    mounted.current = true;
    void bridge.isBrowserSignInPending().then((pending) => {
      if (mounted.current && pending) setWaiting(true);
    });
    void redeem();
    const unsubscribe = bridge.onBrowserSignInResult(() => void redeem());
    return () => {
      mounted.current = false;
      unsubscribe();
      // Signed in some other way while the browser was open: a code arriving later must not sign in again.
      if (useCurrentUserStore.getState().user) void bridge.cancelBrowserSignIn();
    };
  }, [bridge, redeem]);

  if (!bridge) return null;

  /** Open the system browser and wait for its answer. */
  async function start(): Promise<void> {
    if (!bridge) return;
    setWaiting(true);
    await bridge.signInWithBrowser(referralCode);
  }

  /** Stop waiting; a code that arrives later is ignored by the client. */
  async function cancel(): Promise<void> {
    if (!bridge) return;
    await bridge.cancelBrowserSignIn();
    setWaiting(false);
  }

  if (waiting || exchanging) {
    return (
      <div className='flex flex-col items-center gap-2'>
        {/* The label is the instruction to follow in the browser, so it keeps the button's own contrast. */}
        <Button type='button' variant={null} size={null} icon={<GoogleMark className={GOOGLE_MARK_CLASS} />} className={`${GOOGLE_BUTTON_CLASS} cursor-not-allowed opacity-100`} loading>
          {t('auth.desktop.waitingBrowser')}
        </Button>
        {exchanging ? null : (
          <Button type='button' variant='link' size='sm' onClick={() => void cancel()}>
            {t('auth.desktop.cancel')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Button
      type='button'
      variant={null}
      size={null}
      icon={<GoogleMark className={GOOGLE_MARK_CLASS} />}
      className={GOOGLE_BUTTON_CLASS}
      disabled={busy}
      onClick={() => void start()}
    >
      {t('auth.google.continue')}
    </Button>
  );
}
