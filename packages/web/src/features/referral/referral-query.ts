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
 * The membership panel's referral view; `null` while payments are off (404).
 * @returns The query; its data is `undefined` until the first answer.
 */
export function useAccountReferral(): UseQueryResult<AccountReferral | null> {
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  return useQuery({
    queryKey: referralQueryKey(userId),
    queryFn: async (): Promise<AccountReferral | null> => {
      try {
        return await referralApi.get();
      } catch (err) {
        if (err instanceof ApiException && err.status === 404) return null;
        throw err;
      }
    },
    enabled: userId !== null,
  });
}

/**
 * The Chinese "N zhe" figure for a percent off: 20 gives 8, 15 gives 8.5.
 * @param percent - The percent off.
 * @returns The figure without a trailing ".0".
 */
export function zheOf(percent: number): string {
  return String((100 - percent) / 10).replace(/\.0$/, '');
}
