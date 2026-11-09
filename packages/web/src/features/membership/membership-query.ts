// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What every account's membership answer is cached under. Invalidating it
 * refreshes the panel whichever account is signed in.
 */
export const MEMBERSHIP_QUERY_ROOT = ['account', 'membership'] as const;

/**
 * The cache key the membership panel's answer lives under.
 *
 * Keyed on the account, the way the notification inbox is; the provider also
 * empties the whole cache when the signed-in account changes
 * (`QueryClientProvider`).
 * @param userId - The signed-in account, or null before it is known.
 * @returns The query key.
 */
export function membershipQueryKey(
  userId: string | null,
): readonly [...typeof MEMBERSHIP_QUERY_ROOT, string | null] {
  return [...MEMBERSHIP_QUERY_ROOT, userId];
}
