// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
): readonly ['account', 'membership', string | null] {
  return ['account', 'membership', userId];
}
