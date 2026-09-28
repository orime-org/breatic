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
 *
 * It carries the account, the way the membership panel's does: the query
 * client is a module singleton that a sign-out never clears, so a key without
 * the account would hand the next person to sign in on this tab the last
 * one's figures.
 * @param userId - Whose money, or null while nobody is signed in.
 * @returns That key.
 */
export function creditOverviewKey(userId: string | null): readonly unknown[] {
  return ['credits', 'overview', userId];
}

/**
 * What the account holds, as its three figures.
 *
 * The gate is the account menu's: that menu is mounted by the studio layout,
 * so every signed-in account reaches it on every page, and an ungated read
 * would spend a request per navigation on a figure nobody has asked to see.
 * The credits overlay is mounted by a Radix portal that unmounts on close, so
 * it is already asking only while somebody is looking.
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
    // Read again every time a screen opens. The default holds an answer for
    // thirty seconds, which is the right trade for most things and the wrong
    // one for this: every generation spends credits, so a figure held from
    // the last open is a number the account had rather than the one it has,
    // and answering the second question is why this row exists.
    staleTime: 0,
  });
}
