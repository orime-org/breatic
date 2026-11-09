// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { referralApi, type AccountReferral } from '@web/data/api/referral';
import { ApiException } from '@web/data/api/types';
import { MEMBERSHIP_QUERY_ROOT } from '@web/features/membership/membership-query';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * The cache key of an account's referral view.
 *
 * Under the membership root, so whatever refreshes the panel refreshes this
 * too, and keyed on the account like the membership key.
 * @param userId - The signed-in account.
 * @returns The query key.
 */
export function referralQueryKey(userId: string | null): readonly [...typeof MEMBERSHIP_QUERY_ROOT, 'referral', string | null] {
  return [...MEMBERSHIP_QUERY_ROOT, 'referral', userId];
}

/**
 * Reads the account's referral view.
 * @returns The view, or `null` while payments are off (404).
 * @throws {ApiException} Any other refusal or a failed request.
 */
async function readAccountReferral(): Promise<AccountReferral | null> {
  try {
    return await referralApi.get();
  } catch (err) {
    if (err instanceof ApiException && err.status === 404) return null;
    throw err;
  }
}

/**
 * The query an account's referral view is read through, for hooks and for `fetchQuery`.
 * @param userId - The signed-in account.
 * @returns The query key and function.
 */
export function referralQueryOptions(userId: string | null): {
  queryKey: ReturnType<typeof referralQueryKey>;
  queryFn: () => Promise<AccountReferral | null>;
} {
  return { queryKey: referralQueryKey(userId), queryFn: readAccountReferral };
}

/**
 * The account's referral view; `null` while payments are off (404).
 * @param enabled - Whether to read now; the account menu reads only while it is open.
 * @returns The query; its data is `undefined` until the first answer.
 */
export function useAccountReferral(enabled = true): UseQueryResult<AccountReferral | null> {
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  return useQuery({ ...referralQueryOptions(userId), enabled: enabled && userId !== null });
}

/**
 * What the account menu's promoter entry does for this view: only says the
 * program is closed to someone with nothing to look at, and opens the dialog
 * for everyone else, so a promoter keeps their code while applications are shut.
 * @param view - The account's referral view.
 * @returns `closed` to say so, `dialog` to open the promoter dialog.
 */
export function promoterEntryAction(view: AccountReferral): 'closed' | 'dialog' {
  return !view.program.open && view.promoter.state === 'none' ? 'closed' : 'dialog';
}

/**
 * The Chinese "N zhe" figure for a percent off: 20 gives 8, 15 gives 8.5.
 * @param percent - The percent off.
 * @returns The figure without a trailing ".0".
 */
export function zheOf(percent: number): string {
  return String((100 - percent) / 10).replace(/\.0$/, '');
}
