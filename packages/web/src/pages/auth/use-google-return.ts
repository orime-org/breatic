// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { reportConversion } from '@web/data/analytics';
import { toCurrentUser, useCurrentUserStore } from '@web/stores/current-user';
import { useTranslation } from '@web/i18n/use-translation';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { toast } from '@web/lib/toast';
import { AUTH_OPTIONS_QUERY_KEY, type SignupReferral } from '@web/features/referral/use-signup-referral';
import {
  GOOGLE_RETURN_PARAMS,
  clearGoogleReferral,
  googleErrorKey,
  readGoogleReferral,
  readGoogleReturn,
  type GoogleReturn,
  type SavedGoogleReferral,
} from '@web/pages/auth/google-return';

/** What the page arrived with from the Google callback, read once. */
export interface GoogleArrival {
  answer: GoogleReturn | null;
  /** The referral state saved before the post; only after a return. */
  saved: SavedGoogleReferral | null;
}

/**
 * Read once, on the first render, what the callback sent the page back with.
 * The saved referral state is read but not removed here: the removal is an
 * effect, so a repeated first render reads the same state.
 * @returns The answer and the saved referral state.
 */
export function useGoogleArrival(): GoogleArrival {
  const [params] = useSearchParams();
  const [arrival] = React.useState((): GoogleArrival => {
    const answer = readGoogleReturn(params);
    return { answer, saved: answer === null ? null : readGoogleReferral() };
  });
  return arrival;
}

/**
 * Whether this deployment offers Google sign-in, from `GET /auth/options`.
 * @returns True once the server says it does.
 */
export function useGoogleSignInShown(): boolean {
  const options = useQuery({ queryKey: AUTH_OPTIONS_QUERY_KEY, queryFn: () => authApi.options(), retry: false });
  return options.data?.googleSignIn === true;
}

/** How a page finishes a Google return. */
export interface GoogleReturnHandling {
  /** Where to go after signing in. */
  destination: (created: boolean) => string;
  /** The page's referral field. */
  referral: SignupReferral;
  /** The callback refused the referral code: show it on the field or row. */
  onReferralInvalid: () => void;
}

/**
 * Finish what the Google callback started: after a session, read the
 * account, report a new one and go on; after a refusal, keep the message for
 * the button and take the callback's parameters out of the address.
 * @param arrival - What the page arrived with.
 * @param handling - The page's choices.
 * @returns The message to show under the Google button, or null.
 */
export function useGoogleReturn(arrival: GoogleArrival, handling: GoogleReturnHandling): string | null {
  const t = useTranslation();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const setUser = useCurrentUserStore((s) => s.setUser);
  const [error, setError] = React.useState<string | null>(null);
  const handled = React.useRef(false);
  const latest = React.useRef(handling);
  latest.current = handling;

  React.useEffect(() => {
    const answer = arrival.answer;
    if (answer === null || handled.current) return;
    handled.current = true;
    clearGoogleReferral();
    if (answer.kind === 'error') {
      if (answer.reason === 'referral_invalid') latest.current.onReferralInvalid();
      else setError(t(googleErrorKey(answer.reason)));
      setParams((current) => {
        const kept = new URLSearchParams(current);
        for (const name of GOOGLE_RETURN_PARAMS) kept.delete(name);
        return kept;
      }, { replace: true });
      return;
    }
    authApi.me().then((user) => {
      setUser(toCurrentUser(user));
      // An existing account keeps the carried code: the warning points to the panel, which fills from it.
      if (answer.created) {
        reportConversion('signup', `signup:${user.id}`);
        latest.current.referral.used();
      }
      // Before navigating: the Toaster sits outside the router and keeps it (inner#1868 §10).
      if (answer.referralNotApplied) toast.warning(t('auth.referral.existingAccount'));
      void changeLocale(user.locale);
      navigate(latest.current.destination(answer.created), { replace: true });
    }).catch((err: unknown) => {
      setError(err instanceof ApiException ? err.message : t('auth.login.failed'));
    });
  }, [arrival, navigate, setParams, setUser, t]);

  return error;
}
