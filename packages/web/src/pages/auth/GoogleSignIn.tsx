// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import '@fontsource/google-sans/500.css';
import { getLocale } from '@breatic/shared';
import { API_BASE_PATH } from '@web/data/api/base-path';
import { attributionBody } from '@web/data/analytics';
import type { SignupReferralFields } from '@web/data/api/auth';
import { Button } from '@web/components/ui/button';
import { FieldError } from '@web/components/FieldError';
import { useTranslation } from '@web/i18n/use-translation';

/** Where the sign-in form posts: a page navigation, not an API call (inner#2157). */
const BEGIN_ACTION = `${API_BASE_PATH}/auth/google/begin`;

interface GoogleSignInProps {
  /** The page the sign-in starts on and returns to. */
  page: 'login' | 'register';
  /** Where the page goes after signing in. */
  next: string;
  /** The referral code fields to carry, read when the form is posted. */
  referral: SignupReferralFields;
  /** Another submission on the page is in flight. */
  disabled: boolean;
  /** Why the last Google sign-in came back without a session, or null. */
  error: string | null;
  /** Runs just before the browser leaves for Google: save what the return needs, report the start. */
  onLeave: () => void;
}

/** The mark's four colours, fixed by Google's branding guidelines in both themes. */
const MARK = {
  red: '#EA4335', // design-value: allow
  blue: '#4285F4', // design-value: allow
  yellow: '#FBBC05', // design-value: allow
  green: '#34A853', // design-value: allow
} as const;

/**
 * Google's standard multicolour "G", drawn as Google's branding guidelines give it.
 * @returns The mark.
 */
function GoogleMark(): React.JSX.Element {
  return (
    <svg aria-hidden='true' viewBox='0 0 48 48' className='size-[18px] shrink-0'>
      <path fill={MARK.red} d='M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z' />
      <path fill={MARK.blue} d='M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z' />
      <path fill={MARK.yellow} d='M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z' />
      <path fill={MARK.green} d='M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z' />
    </svg>
  );
}

/**
 * "Continue with Google": a form that posts to the server's begin endpoint, so
 * the whole page goes to Google and comes back to this page. The button keeps
 * waiting until the page is gone; coming back through the browser's back
 * button lets it be pressed again.
 * @param props - The page's sign-in context.
 * @param props.page - The page the sign-in starts on and returns to.
 * @param props.next - Where the page goes after signing in.
 * @param props.referral - The referral code fields to carry.
 * @param props.disabled - Another submission on the page is in flight.
 * @param props.error - Why the last Google sign-in came back without a session.
 * @param props.onLeave - Runs just before the browser leaves for Google.
 * @returns The form with its button and the last failure.
 */
export function GoogleSignIn({ page, next, referral, disabled, error, onLeave }: GoogleSignInProps): React.JSX.Element {
  const t = useTranslation();
  const [leaving, setLeaving] = React.useState(false);
  const { attribution } = attributionBody();

  React.useEffect(() => {
    /**
     * A page restored from the back-forward cache is usable again.
     * @param event - The page show event.
     */
    const restore = (event: PageTransitionEvent): void => {
      if (event.persisted) setLeaving(false);
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

  /**
   * Let the post go once: save what the return needs and show the wait.
   * @param event - The form's submit event; cancelled only while already leaving.
   */
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    if (leaving || disabled) {
      event.preventDefault();
      return;
    }
    onLeave();
    setLeaving(true);
  }

  return (
    <div className='flex flex-col gap-2'>
      <form method='post' action={BEGIN_ACTION} onSubmit={handleSubmit}>
        <input type='hidden' name='page' value={page} />
        <input type='hidden' name='next' value={next} />
        <input type='hidden' name='locale' value={getLocale()} />
        {attribution ? <input type='hidden' name='attribution' value={JSON.stringify(attribution)} /> : null}
        {referral.referralCode ? <input type='hidden' name='referralCode' value={referral.referralCode} /> : null}
        {referral.referralSource ? <input type='hidden' name='referralSource' value={referral.referralSource} /> : null}
        <Button
          type='submit'
          variant={null}
          size={null}
          loading={leaving}
          disabled={disabled}
          icon={<GoogleMark />}
          className='relative inline-flex h-10 w-full items-center justify-center gap-2.5 overflow-hidden rounded-full border border-[var(--google-button-border)] bg-[var(--google-button-bg)] px-3 [font-family:Google_Sans,var(--font-sans)] text-sm font-medium leading-5 text-[var(--google-button-fg)] after:pointer-events-none after:absolute after:inset-0 after:bg-current after:opacity-0 after:transition-opacity hover-enabled:after:opacity-[0.08] disabled:cursor-not-allowed disabled:opacity-50'
        >
          {t('auth.google.continue')}
        </Button>
      </form>
      {error ? <FieldError role='alert' className='text-center'>{error}</FieldError> : null}
    </div>
  );
}
