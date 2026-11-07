// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { authApi, type SignupReferralFields } from '@web/data/api/auth';
import { carriedReferralCode, forgetCarriedReferralCode } from '@web/lib/referral-carry';

/** The deployment options query, shared by every page that reads them. */
export const AUTH_OPTIONS_QUERY_KEY = ['auth', 'options'] as const;

/** Whether the referral field is drawn: waiting for the options, shown, or absent. */
export type SignupReferralField = 'loading' | 'shown' | 'hidden';

export interface SignupReferral {
  field: SignupReferralField;
  value: string;
  error: string | null;
  /** The visitor edits the field; an error under it clears. */
  change: (value: string) => void;
  /** What the sign-up request carries: nothing for a blank or hidden field. */
  body: () => SignupReferralFields;
  /** The server refused the code: show why and stop offering the carried one. */
  refused: (message: string) => void;
  /** The sign-up went through: the carried code has done its job. */
  used: () => void;
}

/**
 * The referral code field shared by the sign-up and sign-in pages (inner#1868 §10).
 *
 * The field exists only while the deployment takes payments; while that is
 * being read the pages show a placeholder and keep their buttons waiting, and
 * when it cannot be read the field shows anyway, since the server ignores a
 * code it does not want. The field shows exactly what is sent.
 * @returns The field's state and its actions.
 */
export function useSignupReferral(): SignupReferral {
  const options = useQuery({ queryKey: AUTH_OPTIONS_QUERY_KEY, queryFn: () => authApi.options(), retry: false });
  const [carried] = React.useState(carriedReferralCode);
  const [value, setValue] = React.useState(carried ?? '');
  const [error, setError] = React.useState<string | null>(null);

  const field: SignupReferralField = options.isPending
    ? 'loading'
    : options.isError || options.data.referralEnabled ? 'shown' : 'hidden';

  const change = React.useCallback((next: string): void => {
    setValue(next);
    setError(null);
  }, []);

  const body = React.useCallback((): SignupReferralFields => {
    const code = value.trim();
    if (field !== 'shown' || code === '') return {};
    return { referralCode: code, referralSource: carried !== null && value === carried ? 'signup_link' : 'signup_typed' };
  }, [field, value, carried]);

  const refused = React.useCallback((message: string): void => {
    setError(message);
    forgetCarriedReferralCode();
  }, []);

  const used = React.useCallback((): void => {
    forgetCarriedReferralCode();
  }, []);

  return React.useMemo(
    () => ({ field, value, error, change, body, refused, used }),
    [field, value, error, change, body, refused, used],
  );
}
