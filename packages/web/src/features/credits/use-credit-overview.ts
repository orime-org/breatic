// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { CreditOverview } from '@breatic/shared';

import { fetchCreditOverview } from '@web/data/api/credits';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * The key the account's three figures are cached under.
 *
 * Two screens read them — the account menu and the credits overlay — and a
 * write that moves a purchase marks them stale. All three name the same key
 * through this, so a change of shape reaches every one of them.
 * @param userId - Whose money, or null while nobody is signed in.
 * @returns That key.
 */
export function creditOverviewKey(userId: string | null): readonly unknown[] {
  return ['credits', 'overview', userId];
}

/**
 * What the account holds, as its three figures.
 *
 * Read only while the screen asking for it is open: both callers are mounted
 * for the whole session, so an ungated read would spend a request per
 * navigation on a figure nobody has asked to see.
 * @param enabled - Whether the screen asking for it is open.
 * @returns The query, answering for whoever is signed in.
 */
export function useCreditOverview(
  enabled: boolean,
): UseQueryResult<CreditOverview> {
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  return useQuery({
    queryKey: creditOverviewKey(userId),
    queryFn: () => fetchCreditOverview(),
    enabled: enabled && userId !== null,
  });
}
