// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which membership tier governs an account, and which governs a studio — and
 * the three functions callers actually use, which turn that tier into
 * ceilings.
 *
 * A repo rather than a service: the lookups are queries and nothing else, and
 * table access belongs in one.
 *
 * **Call points do not run the tier lookup and index the config themselves.**
 * They call one of the three exported `…LimitsFor…` functions below, which
 * differ only in what they start from and whether they lock:
 *
 *   - `getLimitsForUser`  — an account, no lock. For reads.
 *   - `lockLimitsForUser` — an account, row locked. Before creating something.
 *   - `getLimitsForStudio`— a studio, resolved through its current admin.
 *
 * Five more ceilings are coming — projects per studio, two kinds of member
 * cap, concurrent writable connections, storage — each with its own check
 * point, so "look up the tier, then index the config" would otherwise end up
 * written out six to eight times across the codebase.
 *
 * There are two routes from an id to a tier here, not one: an account's tier
 * is its own column, a studio's is its admin's. Both end at
 * `getMembershipLimits`. When the enterprise tier arrives — ceilings
 * negotiated per customer, read from the database rather than the config file
 * — BOTH routes need the extra step, because both ultimately answer for an
 * account. `readStudioAdmin` returns that account's id for exactly this
 * reason. Saying "there is one seam" would be tidier and it would be false.
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
import { MEMBERSHIP_TIERS, type MembershipTier } from "@breatic/shared";
import { db, type DbTx } from "@core/db/client.js";
import { studioMembers, studios, users } from "@core/db/schema.js";
import { getMembershipLimits, type MembershipLimits } from "@core/config/membership.js";

const KNOWN_TIERS: ReadonlySet<string> = new Set(MEMBERSHIP_TIERS);

/**
 * Narrow a stored tier string to one this build knows, or throw saying which
 * row holds what.
 *
 * The column is a bare `varchar(16)` with no CHECK constraint, and until the
 * enterprise work lands a hand-written UPDATE is the only way an operator
 * moves somebody off `base`. A typo there used to flow straight through: the
 * value was cast unchecked, `getMembershipLimits` returned undefined for it,
 * and the next property access threw a TypeError whose message named neither
 * the account nor the value. The person creating a studio saw a 500 either
 * way — the data is ours, not theirs — but nobody could tell from the log
 * which row to fix.
 *
 * A CHECK constraint would also stop the write, and was not chosen: it would
 * pin the tier names into a migration, so adding the enterprise tier later
 * would mean altering the constraint rather than extending one list.
 * @param raw - The value stored in `users.membership_tier`
 * @param subject - What to name in the message, e.g. `account <uuid>`
 * @returns The same value, narrowed
 * @throws {Error} if it is not one of `MEMBERSHIP_TIERS`
 */
function asKnownTier(raw: string, subject: string): MembershipTier {
  if (!KNOWN_TIERS.has(raw)) {
    throw new Error(
      `Unknown membership tier ${JSON.stringify(raw)} on ${subject}; ` +
        `this build knows ${MEMBERSHIP_TIERS.join(", ")}`,
    );
  }
  return raw as MembershipTier;
}

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
  return readUserTier(userId, tx, false);
}

/**
 * Read one account's tier, optionally taking a row lock on the way.
 * @param userId - The account to look up
 * @param tx - Transaction handle, if the caller is inside one
 * @param lock - Whether to take `FOR UPDATE` on the account's row
 * @returns That account's tier
 * @throws {Error} if no live account has that id, or its stored tier is not
 *   one this build knows
 */
async function readUserTier(
  userId: string,
  tx: DbTx | undefined,
  lock: boolean,
): Promise<MembershipTier> {
  const query = (tx ?? db)
    .select({ tier: users.membershipTier })
    .from(users)
    // Both conditions name columns a concurrent writer leaves alone, which is
    // what makes the lock sound: after waiting, the re-check still matches the
    // row. A condition naming a column the other side rewrites would make the
    // row vanish from the result at exactly the moment the lock matters.
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));

  const rows = await (lock ? query.for("update") : query).limit(1);

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
  return asKnownTier(tier, `account ${userId}`);
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
  return (await readStudioAdmin(studioId, tx)).tier;
}

/**
 * The account that administers a studio, and that account's tier.
 *
 * Both come from one join because both are needed together: the tier decides
 * the ceilings, and the account id is what an operator has to go and fix when
 * the tier turns out not to be one this build knows. Reporting only the studio
 * would name the thing they have in hand rather than the row they must edit.
 * @param studioId - The studio to resolve
 * @param tx - Optional transaction handle; see {@link getUserMembershipTier}
 * @returns The current admin's account id and tier
 * @throws {Error} if the studio is gone, has no live admin, that admin's
 *   account is gone, or their stored tier is not one this build knows
 */
async function readStudioAdmin(
  studioId: string,
  tx?: DbTx,
): Promise<{ adminUserId: string; tier: MembershipTier }> {
  const rows = await (tx ?? db)
    .select({ tier: users.membershipTier, adminUserId: users.id })
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

  const row = rows[0];
  if (row === undefined) {
    // Plain Error for the same reason as above, and more plainly still: a
    // studio without exactly one live admin is corruption on our side. The
    // person whose request happens to touch it should see a 500, and we
    // should see it in the log.
    throw new Error(`No live admin for studio ${studioId}`);
  }
  return {
    adminUserId: row.adminUserId,
    tier: asKnownTier(
      row.tier,
      `account ${row.adminUserId}, the admin of studio ${studioId}`,
    ),
  };
}

/**
 * The ceilings that apply to an account: its own tier's.
 *
 * The one entry point for "what may this account do", together with
 * {@link getLimitsForStudio}. See this file's header for why call points do
 * not run the two steps themselves.
 * @param userId - The account whose ceilings to resolve
 * @param tx - Optional transaction handle; see {@link getUserMembershipTier}
 * @returns That tier's six ceilings
 * @throws {Error} if no live account has that id, or its stored tier is not
 *   one this build knows
 */
export async function getLimitsForUser(
  userId: string,
  tx?: DbTx,
): Promise<MembershipLimits> {
  return getMembershipLimits(await readUserTier(userId, tx, false));
}

/**
 * The ceilings that apply to a studio: its current admin's tier's.
 * @param studioId - The studio whose ceilings to resolve
 * @param tx - Optional transaction handle; see {@link getUserMembershipTier}
 * @returns That tier's six ceilings
 * @throws {Error} if the studio has no live admin, or that admin's stored
 *   tier is not one this build knows
 */
export async function getLimitsForStudio(
  studioId: string,
  tx?: DbTx,
): Promise<MembershipLimits> {
  return getMembershipLimits((await readStudioAdmin(studioId, tx)).tier);
}

/**
 * The ceilings that apply to an account, with that account's row locked for
 * the rest of the transaction.
 *
 * This is the one to call before deciding whether something may be created.
 * {@link getLimitsForUser} answers the same question without the lock and is
 * for reads — showing somebody what their plan allows.
 *
 * Counting rows and then inserting is not a decision under concurrency: two
 * transactions both count, both see room, and both insert. That was tolerable
 * while the number was an internal anti-abuse cap of 50 and being one over it
 * meant nothing. It is not tolerable now that the number is what somebody
 * paid for — measured on a `pro` account, whose ceiling is one team studio,
 * three simultaneous requests left two rows behind.
 *
 * Locking the account row serialises exactly the requests that could race:
 * the second one waits, then counts and sees the first one's row. Different
 * accounts take different rows and never wait on each other.
 * @param userId - The account whose ceilings to resolve and whose row to lock
 * @param tx - The enclosing transaction; the lock is meaningless without one
 * @returns That tier's six ceilings
 * @throws {Error} if no live account has that id, or its stored tier is not
 *   one this build knows
 */
export async function lockLimitsForUser(
  userId: string,
  tx: DbTx,
): Promise<MembershipLimits> {
  return getMembershipLimits(await readUserTier(userId, tx, true));
}
