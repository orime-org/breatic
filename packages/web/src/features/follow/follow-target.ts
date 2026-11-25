// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { FollowOther } from '@web/stores/follow';

/**
 * Whom a member follows here (#920): this user, a member on the roster by
 * name, or nobody. Someone off the roster counts as nobody, as nobody here can
 * be taken to them.
 * @param following - The user id the member's view says they follow, if any.
 * @param currentUserId - This user's id, or null before it is known.
 * @param names - The project roster: each member's display name by user id.
 * @returns Whom they follow, or null for nobody.
 */
export function followTarget(
  following: string | null | undefined,
  currentUserId: string | null | undefined,
  names: ReadonlyMap<string, string>,
): FollowOther | null {
  if (following === null || following === undefined) return null;
  if (following === currentUserId) return 'you';
  const name = names.get(following);
  return name === undefined ? null : { name };
}
