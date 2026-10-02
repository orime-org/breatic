// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What every account's membership answer is cached under. Invalidating it
 * refreshes the panel whichever account is signed in.
 */
export const MEMBERSHIP_QUERY_ROOT = ['account', 'membership'] as const;

/**
 * The cache key the membership panel's answer lives under.
 *
 * Keyed on the account, the way the notification inbox is. Without it, one
 * account's tier and storage figures sit in the cache under a name the next
 * account signing in on this tab matches exactly — and the client is a module
 * singleton that a client-side sign-out never clears, so the second person
 * would read the first one's billing figures.
 * @param userId - The signed-in account, or null before it is known.
 * @returns The query key.
 */
export function membershipQueryKey(
  userId: string | null,
): readonly [...typeof MEMBERSHIP_QUERY_ROOT, string | null] {
  return [...MEMBERSHIP_QUERY_ROOT, userId];
}
