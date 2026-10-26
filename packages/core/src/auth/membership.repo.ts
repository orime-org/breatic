// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Membership identity, negotiated records and entitlement reads shared by
 * server and collab. Account and Studio decisions resolve through one SQL
 * statement containing the current tier, negotiated record and subscription
 * facts. The Studio's current admin owns its limits.
 *
 * Counted-set locks remain with their callers: account locks protect the
 * number of administered Studios, while Studio and Project locks protect
 * their own additions. Reads price one complete revision at a single instant.
 * Existing objects retain their state when an entitlement expires.
 *
 * Enterprise plan presentation keeps its negotiated-agreement branch, and
 * enterprise storage keeps its exemption. A legacy enterprise account whose
 * negotiated record is absent remains explicit and quota checks name it.
 */

import { and, eq, isNull, getTableColumns, sql } from "drizzle-orm";
import {
  MEMBERSHIP_TIERS,
  type MembershipTier,
} from "@breatic/shared";
import { db, type DbTx } from "@core/db/client.js";
import {
  membershipTierChanges,
  enterpriseMemberships,
  studioMembers,
  studios,
  users,
} from "@core/db/schema.js";
import * as projectsRepo from "@core/project/projects.repo.js";
import { getMembershipLimits, type MembershipLimits } from "@core/config/membership.js";
import { subscriptionClock } from "@core/config/subscription.js";
import { subscriptionFactsForMembership } from "@core/auth/subscription.repo.js";
import { resolveMembershipReading } from "@core/auth/membership-reading.js";
import { enterpriseRecordSchema, enterpriseMembershipProfileSchema } from "@core/auth/enterprise-membership-contract.js";
import type { EnterpriseRecord, RawMembershipSnapshot, EnterpriseMembershipWrite, EnterpriseMembershipProfile } from "@core/auth/enterprise-membership-contract.js";

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
 * Read limits already resolved from the same membership snapshot.
 * @param tier - The tier effective at that snapshot.
 * @param subject - The account and optional Studio for an actionable error.
 * @param negotiated - Negotiated limits when the record is active.
 * @returns The six limits.
 * @throws {Error} When a legacy enterprise account has no negotiated record.
 */
function limitsFor(tier: MembershipTier, subject: TierSubject, negotiated: MembershipLimits | null): MembershipLimits {
  if (tier === "enterprise") {
    if (negotiated !== null) return negotiated;
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
 * Read the tier an account is actually entitled to right now.
 *
 * The same complete snapshot resolves its limits and enterprise or
 * ordinary subscription expiry.
 * @param userId - The account to look up
 * @param tx - Transaction handle, if the caller is inside one
 * @returns The tier in force
 * @throws {Error} if no live account has that id, or its stored tier is not
 *   one this build knows
 */
export async function getHonouredTierForUser(
  userId: string,
  tx?: DbTx,
): Promise<MembershipTier> {
  return (await getMembershipReadingForUser(userId, tx)).effectiveTier;
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


/** An account's tier in force, and the ceilings it carries. */
export interface AccountMembershipReading {
  /** The tier the account's ceilings are read from. */
  readonly tier: MembershipTier;
  /** Its six ceilings; null for `enterprise`, whose ceilings are negotiated. */
  readonly limits: MembershipLimits | null;
}

/**
 * What an account's plan allows, for showing it: its tier in force and that
 * tier's ceilings, from one reading.
 *
 * Enterprise presentation uses the negotiated-agreement branch. Enforcement
 * receives the stored negotiated limits through the quota lookups.
 * @param userId - The account.
 * @param tx - Optional transaction handle; see {@link getUserMembershipTier}
 * @returns Its tier in force and that tier's ceilings.
 * @throws {Error} if no live account has that id, or its stored tier is not
 *   one this build knows
 */
export async function getMembershipForUser(
  userId: string,
  tx?: DbTx,
): Promise<AccountMembershipReading> {
  const reading = await getMembershipReadingForUser(userId, tx);
  return { tier: reading.effectiveTier, limits: reading.effectiveTier === "enterprise" ? null : reading.limits };
}

/**
 * Takes the account's row for the rest of the transaction, reading nothing.
 *
 * For a caller that must serialise on the account BEFORE it goes and fetches
 * the facts it is about to write — the subscription webhook does, because two
 * events for one account would otherwise each ask Stripe for the current state
 * and the one that commits last could be holding the older answer.
 *
 * `changeMembershipTier` takes the same lock, so a caller that only writes at
 * the end needs nothing from here.
 * @param userId - The account to lock.
 * @param tx - The enclosing transaction; the lock is meaningless without one.
 * @throws {Error} if no live account has that id.
 */
export async function lockAccountRow(userId: string, tx: DbTx): Promise<void> {
  await readUserTier(userId, tx, true);
}

/**
 * Who administers a studio, and how many bytes that account's tier allows.
 *
 * Effective enterprise membership keeps its storage exemption, including a
 * legacy account awaiting complete information. Other effective tiers use
 * their configured storage ceiling from the same membership read.
 *
 * Answers the admin id too, because a storage decision needs it twice over:
 * the usage roll-up is per ACCOUNT across every studio that account
 * administers, and it is that account, not whoever tripped the gate, who gets
 * told the storage is full and can do something about it.
 * @param studioId - The studio whose storage ceiling to resolve
 * @param tx - Optional transaction handle; see {@link getUserMembershipTier}
 *   for why a caller inside a transaction must pass it
 * @returns The current admin's account id, and that account's storage ceiling
 *   in bytes — `null` while the effective tier is enterprise
 * @throws {Error} if the studio is gone, or has no live admin, or that admin's
 *   stored tier is not one this build knows — all three are corruption
 */
export async function getStudioStorageQuota(
  studioId: string,
  tx?: DbTx,
): Promise<{ adminUserId: string; storageBytes: number | null }> {
  const reading = await getMembershipReadingForStudio(studioId, tx);
  return { adminUserId: reading.subject.accountId, storageBytes: reading.storageBytes };
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
  const reading = await getMembershipReadingForStudio(studioId, tx);
  return limitsFor(reading.effectiveTier, reading.subject, reading.limits);
}

/**
 * The ceilings that apply to an account, with that account's row locked for
 * the rest of the transaction.
 *
 * Call this when the thing being counted BELONGS TO THE ACCOUNT — today that
 * is exactly one ceiling, how many team studios this account administers.
 * {@link getMembershipForUser} reads the same tier without the lock, for showing
 * somebody what their plan allows; it answers an enterprise account with no
 * ceilings instead of refusing it.
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
  await lockAccountRow(userId, tx);
  const reading = await getMembershipReadingForUser(userId, tx);
  return limitsFor(reading.effectiveTier, reading.subject, reading.limits);
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
 * negotiated enterprise tier is read from the database, and a call point
 * that walked its own path could answer from different facts. The extra primary-key
 * lookup is affordable here: this runs once per SPACE-DOCUMENT handshake, and
 * nowhere near per edit. The meta doc does not reach it at all — `auth.ts`
 * skips the whole ceiling decision for meta and for viewers. So the cost of
 * opening a project is one lookup per open Space tab THAT HAS A DOCUMENT, not
 * one for the project: each such tab attaches its own document and each one
 * handshakes (see the web side's `OpenSpace`; `DOC_NAME_BUILDERS` in
 * `data/yjs/space-connection.ts` decides which types have one — timeline has
 * none today and costs nothing).
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
 * Registration is represented by the first change row's from_tier. Manual
 * membership management and subscription settlement use this writer.
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
 * The only writer of `users.membership_tier` outside registration. It records
 * the raw tier and its history; the enterprise management transaction also
 * saves negotiated information. Same-tier edits can update that information
 * while this writer returns without another tier-change row. Capacity checks
 * resolve the current complete membership snapshot at the time of an action.
 * Existing Studios, Projects and members remain after a downgrade; subsequent
 * additions use the newly effective capacity.
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
 * `updatePaymentStatusCAS` and `chargeOnceForGeneration` already do.
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

/** A complete decision derived from one account and subscription snapshot. */
export type MembershipReading = EnterpriseMembershipProfile["reading"] & {
  subject: TierSubject;
  storedTier: MembershipTier;
};

/**
 * Convert a negotiated database record to the wire's immutable facts.
 * @param row - The complete SQL record.
 * @returns Its validated representation.
 * @throws {Error} When stored membership facts violate the contract.
 */
function enterpriseRecordOf(row: typeof enterpriseMemberships.$inferSelect): EnterpriseRecord {
  return enterpriseRecordSchema.parse({
    expiresAt: row.expiresAt.toISOString(), entryTimezone: row.entryTimezone,
    contractNumber: row.contractNumber, fallbackTier: row.fallbackTier, revision: row.revision,
    limits: { team_studios: row.teamStudios, projects_per_studio: row.projectsPerStudio, concurrent_editors: row.concurrentEditors, studio_members: row.studioMembers, project_members: row.projectMembers, storage_bytes: row.storageBytes },
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Read every membership fact with one SQL statement, resolving Studio ownership inside it.
 * @param target - An account or Studio identity.
 * @param tx - The caller's transaction.
 * @returns The profile and its membership subject, or null for an absent subject.
 * @throws {Error} When membership data or tier configuration is invalid.
 */
async function readMembershipProfile(target: { userId: string } | { studioId: string }, tx?: DbTx): Promise<{ profile: EnterpriseMembershipProfile; subject: TierSubject } | null> {
  const selection = {
    userId: users.id, email: users.email, storedTier: users.membershipTier,
    enterprise: getTableColumns(enterpriseMemberships),
    facts: subscriptionFactsForMembership(users.id),
    asOf: sql<string>`statement_timestamp()`,
  };
  const query = (tx ?? db).select(selection).from(users).leftJoin(enterpriseMemberships, and(eq(enterpriseMemberships.userId, users.id), isNull(enterpriseMemberships.deletedAt)));
  const rows = "userId" in target
    ? await query.where(and(eq(users.id, target.userId), isNull(users.deletedAt))).limit(1)
    : await query.innerJoin(studioMembers, and(eq(studioMembers.userId, users.id), eq(studioMembers.role, "admin"), isNull(studioMembers.deletedAt))).innerJoin(studios, and(eq(studios.id, studioMembers.studioId), eq(studios.id, target.studioId), isNull(studios.deletedAt))).where(isNull(users.deletedAt)).limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const subject: TierSubject = { accountId: row.userId, ...("studioId" in target ? { studioId: target.studioId } : {}) };
  const storedTier = asKnownTier(row.storedTier, subject);
  const enterprise = row.enterprise === null ? null : enterpriseRecordOf(row.enterprise);
  const reading = resolveMembershipReading(storedTier, enterprise, row.facts, { ...subscriptionClock(), now: new Date(row.asOf) });
  return { subject, profile: { account: { id: row.userId, email: row.email }, snapshot: { userId: row.userId, storedTier, enterprise }, reading } };
}

/**
 * Read current membership facts for the internal management interface.
 * @param userId - The account.
 * @param tx - The caller's transaction.
 * @returns Its profile, or null when no live account exists.
 * @throws {Error} When stored data or configuration is invalid.
 */
export async function getEnterpriseMembershipProfile(userId: string, tx?: DbTx): Promise<EnterpriseMembershipProfile | null> {
  const found = await readMembershipProfile({ userId }, tx);
  return found === null ? null : enterpriseMembershipProfileSchema.parse(found.profile);
}

/**
 * Read one account's entitlement and settlement decision from one snapshot.
 * @param userId - The account.
 * @param tx - The caller's transaction.
 * @returns The decision and its raw tier.
 * @throws {Error} When the account is absent or its data is invalid.
 */
export async function getMembershipReadingForUser(userId: string, tx?: DbTx): Promise<MembershipReading> {
  const found = await readMembershipProfile({ userId }, tx);
  if (found === null) throw new Error(`No live account ${userId}`);
  return { ...found.profile.reading, subject: found.subject, storedTier: found.profile.snapshot.storedTier };
}

/**
 * Resolve the current administrator and membership facts together.
 * @param studioId - The Studio.
 * @param tx - The caller's transaction.
 * @returns The current administrator's complete entitlement decision.
 * @throws {Error} When no live administrator exists or its data is invalid.
 */
async function getMembershipReadingForStudio(studioId: string, tx?: DbTx): Promise<MembershipReading> {
  const found = await readMembershipProfile({ studioId }, tx);
  if (found === null) throw new Error(`No live admin for studio ${studioId}`);
  return { ...found.profile.reading, subject: found.subject, storedTier: found.profile.snapshot.storedTier };
}

/**
 * Lock a live account, then read only raw management facts.
 * @param userId - The logical target account.
 * @param tx - The enclosing management transaction.
 * @returns Its raw snapshot, or null for an absent account.
 * @throws {Error} When stored membership facts are invalid.
 */
export async function lockRawMembershipSnapshot(userId: string, tx: DbTx): Promise<RawMembershipSnapshot | null> {
  const [locked] = await tx.select({ storedTier: users.membershipTier }).from(users).where(and(eq(users.id, userId), isNull(users.deletedAt))).for("update").limit(1);
  if (locked === undefined) return null;
  const [enterprise] = await tx.select().from(enterpriseMemberships).where(and(eq(enterpriseMemberships.userId, userId), isNull(enterpriseMemberships.deletedAt))).limit(1);
  return { userId, storedTier: asKnownTier(locked.storedTier, { accountId: userId }), enterprise: enterprise === undefined ? null : enterpriseRecordOf(enterprise) };
}

/**
 * Save complete negotiated facts after the caller has locked the account.
 * @param userId - The account.
 * @param body - Validated operator facts.
 * @param fallbackTier - The preserved or newly captured origin.
 * @param revision - The next checked record revision.
 * @param tx - The enclosing management transaction.
 * @returns The complete saved record.
 * @throws {Error} When the write fails or its result violates the contract.
 */
export async function writeEnterpriseMembershipRecord(userId: string, body: EnterpriseMembershipWrite, fallbackTier: "base" | "self_hosted", revision: number, tx: DbTx): Promise<EnterpriseRecord> {
  const values = {
    userId, expiresAt: new Date(body.expiresAt), entryTimezone: body.entryTimezone, contractNumber: body.contractNumber,
    teamStudios: body.limits.team_studios, projectsPerStudio: body.limits.projects_per_studio, concurrentEditors: body.limits.concurrent_editors,
    studioMembers: body.limits.studio_members, projectMembers: body.limits.project_members, storageBytes: body.limits.storage_bytes,
    fallbackTier, revision, deletedAt: null, updatedAt: sql`statement_timestamp()`,
  };
  const [saved] = await tx.insert(enterpriseMemberships).values(values).onConflictDoUpdate({ target: enterpriseMemberships.userId, set: values }).returning();
  if (saved === undefined) throw new Error(`No saved membership record for ${userId}`);
  return enterpriseRecordOf(saved);
}
