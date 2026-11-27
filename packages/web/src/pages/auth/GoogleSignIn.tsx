// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { getLocale } from '@breatic/shared';
import { API_BASE_PATH } from '@web/data/api/base-path';
import { attributionBody } from '@web/data/analytics';
import type { SignupReferralFields } from '@web/data/api/auth';
import { Button } from '@web/components/ui/button';
import { FieldError } from '@web/components/FieldError';
import { useTranslation } from '@web/i18n/use-translation';
import { GOOGLE_BUTTON_CLASS, GOOGLE_MARK_CLASS, GoogleMark } from '@web/pages/auth/GoogleMark';

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
   * @param event - The form's submit event; cancelled while already leaving or while disabled.
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
          icon={<GoogleMark className={GOOGLE_MARK_CLASS} />}
          className={GOOGLE_BUTTON_CLASS}
        >
          {t('auth.google.continue')}
        </Button>
      </form>
      {error ? <FieldError role='alert' className='text-center'>{error}</FieldError> : null}
    </div>
  );
}
