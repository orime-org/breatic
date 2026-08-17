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
 * The one writer, {@link changeMembershipTier}, is here for the same reason
 * the reads are — one table, one home. It is also why a change to the column
 * needs nothing else to happen afterwards: every ceiling is read at the moment
 * an action is taken, so moving the value IS moving what the account may do.
 *
 * **Call points do not run the tier lookup and index the config themselves.**
 * They call one of the three exported `…LimitsFor…` functions below, which
 * differ only in what they start from and whether they lock:
 *
 *   - `getLimitsForUser`  — an account, no lock. For reads.
 *   - `lockLimitsForUser` — an account, row locked. For the one ceiling whose
 *     counted set belongs to the account: how many team studios it administers.
 *   - `getLimitsForStudio`— a studio, resolved through its current admin. No
 *     lock: a ceiling counted per studio is serialised on the STUDIO's row,
 *     which is not this module's to take (see `studioRepo.lockStudio`).
 *
 * One ceiling is still to come — storage. The two kinds of member cap landed
 * with #87 and the concurrent writable connection ceiling with #88 (see
 * `getProjectConcurrentEditorLimit` below). Each has its own check point, so
 * "look up the tier, then index the config" would otherwise end up written out
 * six to eight times across the codebase.
 *
 * There are two routes from an id to a tier here, not one: an account's tier
 * is its own column, a studio's is its admin's. Both end at `limitsFor`, and
 * both carry the ACCOUNT id there — `readStudioAdmin` returns it for exactly
 * this reason. That is what lets `limitsFor` name the account when it cannot
 * price a tier, and it is where the enterprise ceilings will be read from the
 * database once they are negotiable. Saying "there is one seam" would be
 * tidier and it would be false.
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
import {
  membershipTierChanges,
  studioMembers,
  studios,
  users,
} from "@core/db/schema.js";
import * as projectsRepo from "@core/project/projects.repo.js";
import { getMembershipLimits, type MembershipLimits } from "@core/config/membership.js";

const KNOWN_TIERS: ReadonlySet<string> = new Set(MEMBERSHIP_TIERS);

/**
 * Whose stored tier is being read.
 *
 * The account id is always here, never optional, because the row an operator
 * has to go and edit is a `users` row in both cases. The studio id is what the
 * lookup STARTED from when it started from one — useful context, not the thing
 * that is wrong.
 */
export interface TierSubject {
  /** The account whose column holds the value. */
  accountId: string;
  /** The studio the lookup began at, when it began at one. */
  studioId?: string;
}

/**
 * Name the row a message is about.
 * @param subject - Whose tier is being read
 * @returns A phrase naming the account, and the studio if there was one
 */
function describeSubject(subject: TierSubject): string {
  return subject.studioId === undefined
    ? `account ${subject.accountId}`
    : `account ${subject.accountId}, the admin of studio ${subject.studioId}`;
}

/**
 * Narrow a stored tier string to one this build knows, or throw saying which
 * row holds what.
 *
 * The second of two guards on this column. The first is the CHECK constraint
 * added in 0053, and it is the one that stops a typo from ever landing: an
 * operator moving somebody by hand types the tier name, and `Pro` is not
 * `pro`. This one catches a value that got there anyway — a direct connection,
 * a restored backup, a deployment whose migration did not run. It stays
 * BECAUSE the database can be gone around: without it the value would be cast
 * unchecked and the ceiling lookup would fail with a message naming neither
 * the account nor the value, which is what used to happen.
 *
 * It takes ids rather than a ready-made phrase so the sentence is composed in
 * one place: both routes to a tier end here, and both need the account named.
 * @param raw - The value stored in `users.membership_tier`
 * @param subject - Whose tier this is
 * @returns The same value, narrowed
 * @throws {Error} if it is not one of `MEMBERSHIP_TIERS`
 */
export function asKnownTier(raw: string, subject: TierSubject): MembershipTier {
  if (!KNOWN_TIERS.has(raw)) {
    throw new Error(
      `Unknown membership tier ${JSON.stringify(raw)} on ` +
        `${describeSubject(subject)}; ` +
        `this build knows ${MEMBERSHIP_TIERS.join(", ")}`,
    );
  }
  return raw as MembershipTier;
}

/**
 * Turn a tier into its six ceilings, refusing the one that has none.
 *
 * Every route from an id to a set of numbers goes through here, and that is
 * enforced by a type rather than by discipline: `getMembershipLimits` accepts
 * only a `ConfiguredMembershipTier`, so a caller holding a plain
 * `MembershipTier` cannot reach it without saying out loud what it does about
 * enterprise.
 *
 * Enterprise ceilings are agreed per customer and will be read from the
 * database. Until then the honest answer is not a number: a set invented in
 * `config/membership.yaml` would be enforced against an account nobody agreed
 * it with, and nothing would surface it. This is where that lookup will grow
 * its extra step.
 * @param tier - The tier that governs whatever is being checked
 * @param subject - Whose tier it is, for a message that can be acted on
 * @returns That tier's six ceilings
 * @throws {Error} if the tier is `enterprise`, whose ceilings have no source
 */
function limitsFor(tier: MembershipTier, subject: TierSubject): MembershipLimits {
  if (tier === "enterprise") {
    // Deliberately does NOT name `config/membership.yaml`: whoever reads this
    // has to change that account's tier or wait for negotiated ceilings to be
    // stored, and pointing at the config file would send them to edit the one
    // place these numbers must never be invented.
    throw new Error(
      `Cannot resolve ceilings for ${describeSubject(subject)}: it is on the ` +
        `enterprise tier, whose ceilings are negotiated per customer rather ` +
        `than configured. Move that account onto a tier this deployment ` +
        `configures, or wait for its negotiated ceilings to be stored.`,
    );
  }
  return getMembershipLimits(tier);
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
  return asKnownTier(tier, { accountId: userId });
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
    tier: asKnownTier(row.tier, {
      accountId: row.adminUserId,
      studioId,
    }),
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
  return limitsFor(await readUserTier(userId, tx, false), {
    accountId: userId,
  });
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
  const admin = await readStudioAdmin(studioId, tx);
  return limitsFor(admin.tier, { accountId: admin.adminUserId, studioId });
}

/**
 * The ceilings that apply to an account, with that account's row locked for
 * the rest of the transaction.
 *
 * Call this when the thing being counted BELONGS TO THE ACCOUNT — today that
 * is exactly one ceiling, how many team studios this account administers.
 * {@link getLimitsForUser} answers the same question without the lock and is
 * for reads — showing somebody what their plan allows.
 *
 * **Do not reach for this just because something is about to be created.** The
 * row a quota check locks is the row the COUNTED SET belongs to, which is not
 * always the row the tier is read from; the two coincide here only because an
 * account's team studios belong to that account. Counting projects in a studio
 * locks the `studios` row, counting members of a project locks the `projects`
 * row — taking the admin's account row instead would serialise every studio
 * that person administers against every other, and every project in a studio
 * against every other.
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
  return limitsFor(await readUserTier(userId, tx, true), { accountId: userId });
}

/**
 * How many writable connections one document of this project may hold at once.
 *
 * The collab handshake's entry point (#88). It is the only call point that has
 * to resolve the owning studio ITSELF, because a document name is all collab
 * has: project → studio → that studio's admin → tier. The two invite paths
 * (`projectInvite.service.ts`) also begin from a project id, but each has
 * already loaded the project row for other reasons and reads `studioId` off
 * it, so they call `getLimitsForStudio` directly.
 *
 * It reaches the tier through {@link getLimitsForStudio} rather than joining
 * its own way there. That is not tidiness — those two functions are where the
 * negotiated enterprise tier will be read from the database, and a call point
 * that walked its own path would keep answering from the config file after
 * that lands, with a number that looks perfectly valid. The extra primary-key
 * lookup is affordable here: this runs once per SPACE-DOCUMENT handshake, and
 * nowhere near per edit. The meta doc does not reach it at all — `auth.ts`
 * skips the whole ceiling decision for meta and for viewers. So the cost of
 * opening a project is one lookup per open Space tab THAT HAS A DOCUMENT, not
 * one for the project: each such tab attaches its own document and each one
 * handshakes (see the web side's `SpaceDocSync`, whose `DOC_NAME_BUILDERS`
 * decides which types have one — timeline has none today and costs nothing).
 * Three open canvases, three lookups.
 * Unlike its siblings above it takes NO transaction handle, and that is not an
 * omission: the two queries it makes could not both honour one. Resolving the
 * owning studio goes through `projectsRepo.findOwnerStudioId`, which takes no
 * handle, so a handle passed here would cover the tier lookup and silently
 * leave the studio lookup outside the caller's snapshot — a contract that is
 * true of half the function. Its one caller, collab's `onAuthenticate`, is not
 * in a transaction and does not need one: it decides a ceiling for a
 * connection, it does not write. Should a caller ever need both queries in one
 * snapshot, `findOwnerStudioId` has to learn about handles first.
 * @param projectId - The project whose documents the ceiling applies to
 * @returns How many connections to one of its documents may write at once
 * @throws {Error} if no live project has that id, or the studio that owns it
 *   has no live admin, or that admin's stored tier is not one this build knows
 */
export async function getProjectConcurrentEditorLimit(
  projectId: string,
): Promise<number> {
  // `findOwnerStudioId` owns this query — its own docstring says a query
  // written twice is a query that comes apart, which is what the
  // one-table-one-repo rule exists to prevent. Writing the same select here
  // is exactly the drift it warns about, so this goes through it.
  const studioId = await projectsRepo.findOwnerStudioId(projectId);
  if (studioId === undefined) {
    // Plain Error, like its siblings above: reaching here means a live
    // connection is being made to a document of a project that is gone, which
    // is our data being inconsistent rather than anything the user did. The
    // id is in the message because collab logs this verbatim and it is the
    // only thing that says WHICH project.
    throw new Error(`No live project ${projectId}`);
  }
  return (await getLimitsForStudio(studioId)).concurrent_editors;
}

/**
 * What can cause an account to move between tiers.
 *
 * Stored as written, so the vocabulary is fixed once here rather than each
 * caller inventing a word. Two of the four have no writer yet:
 * `registration` is not appended — every row carries `from_tier`, so the
 * earliest row already says where the account started, and the registration
 * path runs in no transaction — and `manual` waits for an operator entry point
 * that goes through this function rather than around it with hand-written SQL.
 */
export const TIER_CHANGE_REASONS = [
  "registration",
  "manual",
  "subscription_activated",
  "subscription_ended",
] as const;

/** One of the things that can move an account between tiers. */
export type TierChangeReason = (typeof TIER_CHANGE_REASONS)[number];

/**
 * Move an account to a tier, and write down that it moved.
 *
 * The only writer of `users.membership_tier` outside registration. Everything
 * that enforces a ceiling reads that column at the moment of the action, so
 * this one write is the whole of "the account may now do more" — there is no
 * cache to invalidate and no second step.
 *
 * There is deliberately no step after it either. The ratified rule is that
 * ceilings are judged when an action is taken and nothing already created is
 * corrected, so a downgrade removes nothing: the studios, projects and members
 * that exist stay, and only the next attempt to add one is refused.
 *
 * **Concurrency.** The read takes `FOR UPDATE` on the account row, so two
 * changes arriving together queue rather than both reading the same starting
 * tier and one silently discarding the other. Without it the loser's move
 * disappears, which for a paid tier means somebody's upgrade is gone.
 *
 * **This is not idempotency**, and callers must not use it as such. Setting a
 * tier that is already set writes nothing, which absorbs a repeat of the same
 * call; it compares tiers, not event identity, so it cannot tell a redelivered
 * webhook from a new event and converges on whichever call arrives last.
 * Subscription handling keys idempotency on the event itself, the way
 * `updatePaymentStatusCAS` and `deductOnce` already do.
 * @param userId - The account to move
 * @param toTier - The tier it should end up on
 * @param reason - What caused the move
 * @param referenceId - How the trigger is identified upstream, if it is
 * @param tx - The caller's transaction, when the move is part of a larger one.
 *   Without it this opens its own, so the update and the ledger row are always
 *   in the same transaction — a change with no record of it, or a record of a
 *   change that did not happen, are both worse than failing
 * @returns Whether anything changed, and the tier it started from
 * @throws {Error} if no live account has that id — corruption or a caller bug,
 *   never user input, so it is not an AppError
 */
export async function changeMembershipTier(
  userId: string,
  toTier: MembershipTier,
  reason: TierChangeReason,
  referenceId?: string,
  tx?: DbTx,
): Promise<{ changed: boolean; fromTier: MembershipTier }> {
  /**
   * The move itself, given something to run it on.
   *
   * Written once and called with either the caller's handle or a fresh one, so
   * the update and the ledger row cannot end up in different transactions by
   * taking different code paths.
   * @param handle - The transaction to do the work in
   * @returns Whether anything changed, and the tier it started from
   * @throws {Error} if no live account has that id
   */
  const run = async (
    handle: DbTx,
  ): Promise<{ changed: boolean; fromTier: MembershipTier }> => {
    const fromTier = await readUserTier(userId, handle, true);
    if (fromTier === toTier) return { changed: false, fromTier };

    await handle
      .update(users)
      .set({ membershipTier: toTier })
      .where(eq(users.id, userId));
    await handle.insert(membershipTierChanges).values({
      userId,
      fromTier,
      toTier,
      reason,
      referenceId: referenceId ?? null,
    });
    return { changed: true, fromTier };
  };

  return tx ? run(tx) : db.transaction(run);
}
