// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which membership tier governs an account, and which governs a studio.
 *
 * A repo rather than a service: both functions are queries and nothing else,
 * and table access belongs in one.
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
import { db, type DbTx } from "@core/db/client.js";
import { studioMembers, studios, users } from "@core/db/schema.js";

/**
 * The tier an account is on.
 * @param userId - The account to look up
 * @param tx - Optional transaction handle. Callers already inside one must
 *   pass it: a read issued from within a transaction otherwise reaches for a
 *   SECOND pooled connection while the first is still held, which is how the
 *   pool exhausts itself under concurrent writes.
 * @returns That account's membership tier
 * @throws {Error} if no live account has that id — corruption or a caller
 *   bug, never user input, so it is not an AppError
 */
export async function getUserMembershipTier(
  userId: string,
  tx?: DbTx,
): Promise<MembershipTier> {
  const rows = await (tx ?? db)
    .select({ tier: users.membershipTier })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  const tier = rows[0]?.tier;
  if (tier === undefined) {
    // A plain Error, not an AppError. `errorHandler` puts an AppError's
    // message on the wire verbatim, and this sentence is not addressed to a
    // user: every caller resolves the id from a session or from a row it
    // just read, so an id with no live account behind it means our data or
    // our code is wrong, not their input. A plain throw becomes a 500 with
    // the context logged, which is what that is.
    throw new Error(`No live account ${userId}`);
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
 * @param tx - Optional transaction handle; see {@link getUserMembershipTier}
 *   for why a caller inside a transaction must pass it
 * @returns The current admin's membership tier
 * @throws {Error} if the studio is gone, or has no live admin, or that admin's
 *   account is gone — all three are corruption, so it is not an AppError
 */
export async function getStudioMembershipTier(
  studioId: string,
  tx?: DbTx,
): Promise<MembershipTier> {
  const rows = await (tx ?? db)
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
    // Plain Error for the same reason as above, and more plainly still: a
    // studio without exactly one live admin is corruption on our side. The
    // person whose request happens to touch it should see a 500, and we
    // should see it in the log.
    throw new Error(`No live admin for studio ${studioId}`);
  }
  return tier as MembershipTier;
}
