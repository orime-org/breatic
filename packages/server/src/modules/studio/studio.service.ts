// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio service — V1 personal studio lifecycle.
 *
 * Every user has exactly one personal studio. The service exposes an
 * idempotent `ensurePersonalStudio` used by the auth-register flow
 * and the dev-user bootstrap to guarantee invariant.
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import type { Studio } from "@breatic/shared";
import type { DbTx } from "@server/modules/conversation/conversation.repo.js";

/**
 * Default display name for a personal studio.
 *
 * Mirrors Figma's "Drafts" model — a per-user implicit workspace
 * that acts as the FK target for the user's projects until team
 * studios ship.
 * @param username - Display name to personalize the studio name, or null for the generic fallback.
 * @returns A name like `"{username}'s Studio"`, or `"Personal Studio"` when no username is given.
 */
function defaultStudioName(username: string | null): string {
  return username ? `${username}'s Studio` : "Personal Studio";
}

/**
 * Ensure the user has a personal studio, creating one if missing.
 *
 * Idempotent: safe to call from register, login, or any code path
 * that needs to dereference `projects.studio_id` for the user.
 * @param userId - User UUID
 * @param username - Optional display name; falls back to "Personal
 *   Studio" if null
 * @param tx - Optional transaction handle (used by register flows)
 * @returns The user's active personal studio
 */
export async function ensurePersonalStudio(
  userId: string,
  username: string | null,
  tx?: DbTx,
): Promise<Studio> {
  const existing = await studioRepo.getByOwnerUserId(userId);
  if (existing) return existing;
  return studioRepo.createPersonalStudio(userId, defaultStudioName(username), tx);
}

/**
 * Look up a user's personal studio without auto-creating.
 *
 * Use when callers want to surface "no studio" as an error (e.g.
 * project creation expecting register hook to have run).
 * @param userId - User UUID
 * @returns The user's studio, or `null` if none exists
 */
export async function getPersonalStudio(userId: string): Promise<Studio | null> {
  return studioRepo.getByOwnerUserId(userId);
}
