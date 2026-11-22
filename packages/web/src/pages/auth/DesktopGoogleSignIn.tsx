// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { Button } from '@web/components/ui/button';
import { authApi } from '@web/data/api/auth';
import { useTranslation } from '@web/i18n/use-translation';
import { getDesktopBridge } from '@web/lib/desktop-bridge';
import { toast } from '@web/lib/toast';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useCompleteSignIn } from '@web/pages/auth/use-complete-sign-in';

interface DesktopGoogleSignInProps {
  /** The referral code the page carries, handed to the browser's sign-up. */
  referralCode: string | null;
  /** Where the sign-in goes when it finishes. */
  next: string;
  /** Another sign-in on the page is in flight. */
  busy: boolean;
}

/** Google's multicolour "G": each part's fill and outline, fixed by Google's sign-in branding guidelines. */
const GOOGLE_MARK: ReadonlyArray<readonly [string, string]> = [
  ['#4285F4', 'M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z'], // design-value: allow — Google's mark
  ['#34A853', 'M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.33A9 9 0 0 0 9 18Z'], // design-value: allow — Google's mark
  ['#FBBC05', 'M3.96 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3-2.33Z'], // design-value: allow — Google's mark
  ['#EA4335', 'M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z'], // design-value: allow — Google's mark
];

/**
 * The look of Google's official button on the web login page, drawn by us:
 * a pill in Google's colours for the page theme (tokens.css), its blue-tinted
 * hover, the mark 12px from the left and the text centred beside it.
 */
const GOOGLE_BUTTON =
  'relative h-10 w-full cursor-pointer rounded-full border border-(--google-button-stroke) bg-(--google-button-fill) pl-10 pr-3 text-sm font-medium text-(--google-button-text) hover-enabled:border-(--google-button-hover-stroke) hover-enabled:bg-(--google-button-hover)';

/**
 * Google's "G" mark for the sign-in button.
 * @returns The mark.
 */
function GoogleMark(): React.JSX.Element {
  return (
    <svg viewBox='0 0 18 18' aria-hidden='true' className='size-[18px]'>
      {GOOGLE_MARK.map(([fill, d]) => <path key={fill} fill={fill} d={d} />)}
    </svg>
  );
}

/**
 * Google sign-in inside the desktop client (#1599). Google refuses sign-in in
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
        <Button type='button' variant={null} size={null} className={GOOGLE_BUTTON} loading disabled>
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
    <Button type='button' variant={null} size={null} className={GOOGLE_BUTTON} disabled={busy} onClick={() => void start()}>
      <span className='absolute top-1/2 left-3 -translate-y-1/2'>
        <GoogleMark />
      </span>
      {t('auth.desktop.continueWithGoogle')}
    </Button>
  );
}
