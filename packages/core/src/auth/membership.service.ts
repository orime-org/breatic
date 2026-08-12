// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which membership tier governs an account, and which governs a studio.
 *
 * Two lookups because the ratified rule has two halves. How many team studios
 * an account may administer is decided by that account's own tier. Everything
 * a studio caps — projects, members, simultaneous writable connections,
 * storage — is decided by the tier of that studio's CURRENT admin.
 *
 * "Current" is the load-bearing word: adminship transfers, and the studio's
 * ceilings go with it. That is why this reads `studio_members.role`, never the
 * immutable `studios.created_by_user_id` — the same rule the storage roll-up
 * and the team-studio creation quota already follow.
 *
 * A studio has exactly one admin, so there is nothing to choose between; the
 * question "whose tier?" has one answer by construction rather than by policy.
 *
 * Lives in core because three services ask: server for four of the ceilings,
 * collab for the concurrency one, worker for storage on the generation path.
 * Neither collab nor worker may import server, which is where `user.repo`
 * lives.
 *
 * **On reading `users` from here.** `user.repo` owns user BUSINESS logic —
 * creating accounts, passwords, recovery codes — not every read of the table.
 * Joining the shared `users` schema to read one column is the same thing the
 * credit domain already does for balances, and for the same stated reason
 * (`packages/domain/src/credit/credit.repo.ts`, the note above `getBalance`):
 * referencing the schema keeps this decoupled from user business logic rather
 * than duplicating it.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { MembershipTier } from "@breatic/shared";
import { db } from "@core/db/client.js";
import { studioMembers, studios, users } from "@core/db/schema.js";
import { NotFoundError } from "@core/app-errors.js";

/**
 * The tier an account is on.
 * @param userId - The account to look up
 * @returns That account's membership tier
 * @throws {NotFoundError} if no live account has that id
 */
export async function getUserMembershipTier(
  userId: string,
): Promise<MembershipTier> {
  const rows = await db
    .select({ tier: users.membershipTier })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  const tier = rows[0]?.tier;
  if (tier === undefined) {
    throw new NotFoundError(`No live account ${userId}`);
  }
  return tier as MembershipTier;
}

/**
 * The tier that governs a studio's ceilings — its current admin's.
 *
 * Personal studios need no special case: their owner holds the `admin` row
 * like any other studio's does, so the same query answers both.
 *
 * Throws rather than falling back when a studio has no live admin. That state
 * is data corruption (the product keeps exactly one admin per studio), and a
 * fallback tier would silently decide every ceiling on that studio against a
 * number nobody chose — the kind of wrong that surfaces only in an audit.
 * @param studioId - The studio whose governing tier to resolve
 * @returns The current admin's membership tier
 * @throws {NotFoundError} if the studio is gone, or has no live admin, or that
 *   admin's account is gone
 */
export async function getStudioMembershipTier(
  studioId: string,
): Promise<MembershipTier> {
  const rows = await db
    .select({ tier: users.membershipTier })
    .from(studios)
    .innerJoin(studioMembers, eq(studioMembers.studioId, studios.id))
    .innerJoin(users, eq(users.id, studioMembers.userId))
    .where(
      and(
        eq(studios.id, studioId),
        isNull(studios.deletedAt),
        eq(studioMembers.role, "admin"),
        isNull(studioMembers.deletedAt),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);

  const tier = rows[0]?.tier;
  if (tier === undefined) {
    throw new NotFoundError(`No live admin for studio ${studioId}`);
  }
  return tier as MembershipTier;
}
