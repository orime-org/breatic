// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The global directory of every region's Studios (inner#1955): who
 * administers each one, which region it lives in, and whether a transfer
 * offer is open on it. Only the global region reads or writes these rows.
 */

import { and, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { getRegionsConfig } from "@core/config/regions.js";
import {
  directoryReconciliations,
  projectDirectory,
  slugReservations,
  studioDirectory,
  studioDirectoryMembers,
  studioStorageUsageGlobal,
  userRegions,
} from "@core/db/schema.js";

/** The directory facts the credit ledger and transfers decide on. */
export interface DirectoryRow {
  studioId: string;
  slug: string;
  region: string | null;
  type: "personal" | "team";
  name: string;
  avatarUrl: string | null;
  adminUserId: string;
  createdByUserId: string;
  state: "pending" | "live";
  transferPendingUntil: Date | null;
  lastAdminChangeId: string | null;
  deletedAt: Date | null;
}

const columns = {
  studioId: studioDirectory.studioId,
  slug: studioDirectory.slug,
  region: studioDirectory.region,
  type: studioDirectory.type,
  name: studioDirectory.name,
  avatarUrl: studioDirectory.avatarUrl,
  adminUserId: studioDirectory.adminUserId,
  createdByUserId: studioDirectory.createdByUserId,
  state: studioDirectory.state,
  transferPendingUntil: studioDirectory.transferPendingUntil,
  lastAdminChangeId: studioDirectory.lastAdminChangeId,
  deletedAt: studioDirectory.deletedAt,
};

/**
 * Lock one Studio's directory row. The condition names only the id, which no
 * writer changes, so the row a waiting caller receives is the one it asked for.
 * @param studioId - The Studio.
 * @param tx - The transaction holding the lock.
 * @returns The row, or null when the directory has none.
 */
export async function lockRow(studioId: string, tx: DbTx): Promise<DirectoryRow | null> {
  const [row] = await tx.select(columns).from(studioDirectory).where(eq(studioDirectory.studioId, studioId)).for("update").limit(1);
  return row ?? null;
}

/**
 * Read one live Studio's directory row.
 * @param studioId - The Studio.
 * @returns The row, or null when there is none or it was deleted.
 */
export async function findLive(studioId: string): Promise<DirectoryRow | null> {
  const [row] = await db
    .select(columns)
    .from(studioDirectory)
    .where(and(eq(studioDirectory.studioId, studioId), isNull(studioDirectory.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The personal Studio rows of these users, live and deleted; a user who has
 * not finished onboarding has none.
 * @param userIds - The users.
 * @returns Their rows, in no order.
 */
export async function listPersonalByCreators(userIds: readonly string[]): Promise<DirectoryRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select(columns)
    .from(studioDirectory)
    .where(
      and(
        inArray(studioDirectory.createdByUserId, [...userIds]),
        eq(studioDirectory.type, "personal"),
        eq(studioDirectory.state, "live"),
      ),
    );
}

/**
 * One user's live personal Studio row.
 * @param userId - The user.
 * @returns The row, or null before onboarding.
 */
export async function findPersonalByCreator(userId: string): Promise<DirectoryRow | null> {
  const [row] = await db
    .select(columns)
    .from(studioDirectory)
    .where(
      and(
        eq(studioDirectory.createdByUserId, userId),
        eq(studioDirectory.type, "personal"),
        eq(studioDirectory.state, "live"),
        isNull(studioDirectory.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Lock one user's live personal Studio row for a credit grant. The candidate
 * is found first and locked by its id; the type, creator and admin are then
 * judged on the locked row, so a change while it waited is seen.
 * @param userId - The user.
 * @param tx - The grant's transaction, holding the account lock.
 * @returns The row, or null when the user has no live personal Studio they administer.
 */
export async function lockPersonalForGrant(userId: string, tx: DbTx): Promise<DirectoryRow | null> {
  const [candidate] = await tx
    .select({ studioId: studioDirectory.studioId })
    .from(studioDirectory)
    .where(
      and(
        eq(studioDirectory.createdByUserId, userId),
        eq(studioDirectory.type, "personal"),
        eq(studioDirectory.state, "live"),
        isNull(studioDirectory.deletedAt),
      ),
    )
    .limit(1);
  if (!candidate) return null;
  const [row] = await tx
    .select(columns)
    .from(studioDirectory)
    .where(and(eq(studioDirectory.studioId, candidate.studioId), isNull(studioDirectory.deletedAt)))
    .for("no key update")
    .limit(1);
  const usable = row !== undefined && row.type === "personal" && row.state === "live"
    && row.createdByUserId === userId && row.adminUserId === userId;
  return usable ? row : null;
}

/**
 * Name a new admin, recording which change did it.
 * @param studioId - The Studio, already locked by the caller.
 * @param adminUserId - The new admin.
 * @param changeId - The change applied.
 * @param tx - The transaction holding the row lock.
 */
export async function setAdmin(studioId: string, adminUserId: string, changeId: string, tx: DbTx): Promise<void> {
  await tx
    .update(studioDirectory)
    .set({
      adminUserId,
      lastAdminChangeId: changeId,
      version: sql`${studioDirectory.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(studioDirectory.studioId, studioId));
}

/**
 * Record when the Studio's open transfer offer expires, or that none is open.
 * @param studioId - The Studio.
 * @param until - The offer's expiry, or null when it ended.
 * @param tx - The transaction the offer changes in.
 */
export async function setTransferPendingUntil(studioId: string, until: Date | null, tx: DbTx): Promise<void> {
  await tx
    .update(studioDirectory)
    .set({ transferPendingUntil: until, updatedAt: new Date() })
    .where(eq(studioDirectory.studioId, studioId));
}

/** A new directory row. */
export interface NewDirectoryRow {
  studioId: string;
  slug: string;
  region: string | null;
  type: "personal" | "team";
  name: string;
  adminUserId: string;
  createdByUserId: string;
  state: "pending" | "live";
}

/**
 * Hold a slug for this transaction, so the check below and the write that
 * follows it see every other writer of the same slug.
 * @param slug - The slug.
 * @param tx - The transaction holding the lock.
 */
export async function lockSlug(slug: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`studio-slug:${slug}`}))`);
}

/**
 * Whether a slug is held by a Studio in any region, live or still being
 * created, or reserved for a rename.
 * @param slug - The slug.
 * @param tx - The transaction to read in, when there is one.
 * @param exceptStudioId - A Studio whose own hold does not count: the one being renamed.
 * @returns True when nobody else may take it.
 */
export async function isSlugHeld(slug: string, tx?: DbTx, exceptStudioId?: string): Promise<boolean> {
  const runner = tx ?? db;
  const [directory] = await runner
    .select({ id: studioDirectory.studioId })
    .from(studioDirectory)
    .where(and(
      eq(studioDirectory.slug, slug),
      isNull(studioDirectory.deletedAt),
      exceptStudioId === undefined ? undefined : ne(studioDirectory.studioId, exceptStudioId),
    ))
    .limit(1);
  if (directory) return true;
  const [reserved] = await runner
    .select({ id: slugReservations.id })
    .from(slugReservations)
    .where(and(
      eq(slugReservations.slug, slug),
      isNull(slugReservations.deletedAt),
      exceptStudioId === undefined ? undefined : ne(slugReservations.studioId, exceptStudioId),
    ))
    .limit(1);
  return reserved !== undefined;
}

/**
 * The region of the live Studio with this slug.
 * @param slug - The slug.
 * @returns Its region (null for the global region), or undefined when no live Studio has it.
 */
export async function findRegionBySlug(slug: string): Promise<{ region: string | null } | undefined> {
  const [row] = await db
    .select({ region: studioDirectory.region })
    .from(studioDirectory)
    .where(and(eq(studioDirectory.slug, slug), eq(studioDirectory.state, "live"), isNull(studioDirectory.deletedAt)))
    .limit(1);
  return row;
}

/**
 * Read a directory row by id, deleted or not.
 * @param studioId - The Studio.
 * @param tx - The transaction to read in.
 * @returns The row, or null when there is none.
 */
export async function findAny(studioId: string, tx: DbTx): Promise<DirectoryRow | null> {
  const [row] = await tx.select(columns).from(studioDirectory).where(eq(studioDirectory.studioId, studioId)).limit(1);
  return row ?? null;
}

/**
 * A user's creation still waiting on another region, if any.
 * @param userId - The creator.
 * @param tx - The transaction to read in.
 * @returns The pending row, or null.
 */
export async function findPendingByCreator(userId: string, tx: DbTx): Promise<DirectoryRow | null> {
  const [row] = await tx
    .select(columns)
    .from(studioDirectory)
    .where(
      and(
        eq(studioDirectory.createdByUserId, userId),
        eq(studioDirectory.state, "pending"),
        isNull(studioDirectory.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * How many team Studios count toward a user's quota in every region: the live
 * ones they administer and the ones they are still creating.
 * @param userId - The user.
 * @param tx - The transaction holding their account lock, when deciding a creation.
 * @returns The count.
 */
export async function countTeamQuota(userId: string, tx?: DbTx): Promise<number> {
  const [row] = await (tx ?? db)
    .select({ n: sql<number>`count(*)::int` })
    .from(studioDirectory)
    .where(
      and(
        eq(studioDirectory.type, "team"),
        isNull(studioDirectory.deletedAt),
        sql`((${studioDirectory.state} = 'live' AND ${studioDirectory.adminUserId} = ${userId})
          OR (${studioDirectory.state} = 'pending' AND ${studioDirectory.createdByUserId} = ${userId}))`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Write a directory row.
 * @param row - The row.
 * @param tx - The creating transaction.
 */
export async function insertRow(row: NewDirectoryRow, tx: DbTx): Promise<void> {
  await tx.insert(studioDirectory).values(row);
}

/**
 * Turn a pending row live once its region holds the Studio.
 * @param studioId - The Studio.
 * @param tx - The finishing transaction.
 * @returns Whether a pending row turned live.
 */
export async function markLive(studioId: string, tx: DbTx): Promise<boolean> {
  const rows = await tx
    .update(studioDirectory)
    .set({ state: "live", updatedAt: new Date() })
    .where(and(eq(studioDirectory.studioId, studioId), eq(studioDirectory.state, "pending"), isNull(studioDirectory.deletedAt)))
    .returning({ id: studioDirectory.studioId });
  return rows.length > 0;
}

/**
 * Give up a pending row: its slug and quota are free again.
 * @param studioId - The Studio.
 * @param tx - The transaction giving it up.
 */
export async function abandonPending(studioId: string, tx: DbTx): Promise<void> {
  await tx
    .update(studioDirectory)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(studioDirectory.studioId, studioId), eq(studioDirectory.state, "pending"), isNull(studioDirectory.deletedAt)));
}

/**
 * Pending rows older than a sweep waits, oldest first.
 * @param olderThanMs - How long a creation may stay pending first.
 * @returns The rows.
 */
export async function listStalePending(olderThanMs: number): Promise<DirectoryRow[]> {
  return db
    .select(columns)
    .from(studioDirectory)
    .where(
      and(
        eq(studioDirectory.state, "pending"),
        isNull(studioDirectory.deletedAt),
        lte(studioDirectory.createdAt, new Date(Date.now() - olderThanMs)),
      ),
    )
    .orderBy(studioDirectory.createdAt);
}

/**
 * Record a member's role in the global copy of a Studio's membership.
 * @param studioId - The Studio.
 * @param userId - The member.
 * @param role - Their role.
 * @param tx - The writing transaction.
 */
export async function upsertMember(studioId: string, userId: string, role: string, tx: DbTx): Promise<void> {
  await tx
    .insert(studioDirectoryMembers)
    .values({ studioId, userId, role })
    .onConflictDoUpdate({
      target: [studioDirectoryMembers.studioId, studioDirectoryMembers.userId],
      set: { role, deletedAt: null, updatedAt: new Date(), version: sql`${studioDirectoryMembers.version} + 1` },
    });
}

/**
 * Record that a user has members or notifications in a region other than the
 * global one, so the global region's cross-region reads ask it.
 * @param userId - The user.
 * @param region - The region.
 * @param tx - The writing transaction, when there is one.
 */
export async function touchUserRegion(userId: string, region: string, tx?: DbTx): Promise<void> {
  await (tx ?? db).insert(userRegions).values({ userId, region }).onConflictDoNothing();
}

/**
 * Change a Studio's name, avatar or slug in the directory.
 * @param studioId - The Studio.
 * @param profile - The fields that changed.
 * @param profile.name - Its new name.
 * @param profile.avatarUrl - Its new avatar, or null to clear it.
 * @param profile.slug - Its new slug.
 * @param tx - The writing transaction.
 */
export async function updateProfile(
  studioId: string,
  profile: { name?: string; avatarUrl?: string | null; slug?: string },
  tx: DbTx,
): Promise<void> {
  await tx
    .update(studioDirectory)
    .set({ ...profile, updatedAt: new Date(), version: sql`${studioDirectory.version} + 1` })
    .where(eq(studioDirectory.studioId, studioId));
}

/**
 * Remove a member from the global copy of a Studio's membership.
 * @param studioId - The Studio.
 * @param userId - The member.
 * @param tx - The writing transaction.
 */
export async function removeMember(studioId: string, userId: string, tx: DbTx): Promise<void> {
  await tx
    .update(studioDirectoryMembers)
    .set({ deletedAt: new Date(), updatedAt: new Date(), version: sql`${studioDirectoryMembers.version} + 1` })
    .where(
      and(
        eq(studioDirectoryMembers.studioId, studioId),
        eq(studioDirectoryMembers.userId, userId),
        isNull(studioDirectoryMembers.deletedAt),
      ),
    );
}

/**
 * The live members of a Studio in the global copy.
 * @param studioId - The Studio.
 * @param tx - The transaction to read in.
 * @returns Each member's role.
 */
export async function listMembers(studioId: string, tx: DbTx): Promise<{ userId: string; role: string }[]> {
  return tx
    .select({ userId: studioDirectoryMembers.userId, role: studioDirectoryMembers.role })
    .from(studioDirectoryMembers)
    .where(and(eq(studioDirectoryMembers.studioId, studioId), isNull(studioDirectoryMembers.deletedAt)));
}

/**
 * Record which Studio a Project belongs to.
 * @param projectId - The Project.
 * @param studioId - Its Studio.
 * @param tx - The writing transaction.
 */
export async function recordProject(projectId: string, studioId: string, tx: DbTx): Promise<void> {
  await tx.insert(projectDirectory).values({ projectId, studioId }).onConflictDoNothing();
}

/**
 * The Studio and region of a Project.
 * @param projectId - The Project.
 * @returns Its Studio and the Studio's region (null for the global region), or null when unknown.
 */
export async function findProject(projectId: string): Promise<{ studioId: string; region: string | null } | null> {
  const [row] = await db
    .select({ studioId: projectDirectory.studioId, region: studioDirectory.region })
    .from(projectDirectory)
    .innerJoin(studioDirectory, eq(studioDirectory.studioId, projectDirectory.studioId))
    .where(and(eq(projectDirectory.projectId, projectId), isNull(projectDirectory.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The region of each Project, by the Studio it is in.
 * @param projectIds - The Projects.
 * @returns Each known Project's region; null is the global region.
 */
export async function listProjectRegions(projectIds: readonly string[]): Promise<{ projectId: string; region: string | null }[]> {
  if (projectIds.length === 0) return [];
  return db
    .select({ projectId: projectDirectory.projectId, region: studioDirectory.region })
    .from(projectDirectory)
    .innerJoin(studioDirectory, eq(studioDirectory.studioId, projectDirectory.studioId))
    .where(inArray(projectDirectory.projectId, [...projectIds]));
}

/**
 * Hold a new slug for a Studio a region is renaming.
 * @param slug - The slug.
 * @param studioId - The Studio.
 * @param tx - The transaction holding the slug lock.
 */
export async function reserveSlug(slug: string, studioId: string, tx: DbTx): Promise<void> {
  await tx.insert(slugReservations).values({ slug, studioId, expiresAt: new Date(Date.now() + getRegionsConfig().slug_reservation_stale_ms) });
}

/**
 * Whether a Studio holds a live reservation of a slug.
 * @param slug - The slug.
 * @param studioId - The Studio.
 * @param tx - The reading transaction.
 * @returns True when it does.
 */
export async function hasReservation(slug: string, studioId: string, tx: DbTx): Promise<boolean> {
  const [row] = await tx
    .select({ id: slugReservations.id })
    .from(slugReservations)
    .where(and(eq(slugReservations.slug, slug), eq(slugReservations.studioId, studioId), isNull(slugReservations.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/**
 * Hold a Studio's live reservation of a slug for another stale window, so the
 * sweep asks about it again later.
 * @param slug - The slug.
 * @param studioId - The Studio.
 * @param tx - The writing transaction.
 */
export async function extendReservation(slug: string, studioId: string, tx: DbTx): Promise<void> {
  await tx
    .update(slugReservations)
    .set({ expiresAt: new Date(Date.now() + getRegionsConfig().slug_reservation_stale_ms) })
    .where(and(eq(slugReservations.slug, slug), eq(slugReservations.studioId, studioId), isNull(slugReservations.deletedAt)));
}

/**
 * Whether a Studio's live reservation of a slug is past due.
 * @param slug - The slug.
 * @param studioId - The Studio.
 * @param tx - The reading transaction.
 * @returns True when it stands and has fallen due.
 */
export async function isReservationDue(slug: string, studioId: string, tx: DbTx): Promise<boolean> {
  const [row] = await tx
    .select({ id: slugReservations.id })
    .from(slugReservations)
    .where(
      and(
        eq(slugReservations.slug, slug),
        eq(slugReservations.studioId, studioId),
        isNull(slugReservations.deletedAt),
        lte(slugReservations.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Let go of a Studio's reservation of a slug.
 * @param slug - The slug.
 * @param studioId - The Studio.
 * @param tx - The writing transaction.
 */
export async function releaseSlugReservation(slug: string, studioId: string, tx: DbTx): Promise<void> {
  await tx
    .update(slugReservations)
    .set({ deletedAt: new Date() })
    .where(and(eq(slugReservations.slug, slug), eq(slugReservations.studioId, studioId), isNull(slugReservations.deletedAt)));
}

/**
 * Whether the reconciliation after the global region's upgrade has finished.
 * @returns True once its completion mark is written.
 */
export async function isReconciled(): Promise<boolean> {
  const [row] = await db
    .select({ id: directoryReconciliations.id })
    .from(directoryReconciliations)
    .where(isNull(directoryReconciliations.deletedAt))
    .limit(1);
  return row !== undefined;
}

/**
 * Record that the reconciliation after the upgrade has finished.
 */
export async function markReconciled(): Promise<void> {
  await db.insert(directoryReconciliations).values({});
}

/** A Studio the switcher lists, as the directory holds it. */
export interface DirectoryStudioOfUser {
  studioId: string;
  slug: string;
  name: string;
  type: "personal" | "team";
  avatarUrl: string | null;
  region: string | null;
  role: string;
  memberCount: number;
  createdAt: Date;
}

/**
 * Every live Studio a user is a member of, with its member count, oldest first.
 * @param userId - The user.
 * @returns The Studios and the user's role in each.
 */
export async function listStudiosOfUser(userId: string): Promise<DirectoryStudioOfUser[]> {
  return db
    .select({
      studioId: studioDirectory.studioId,
      slug: studioDirectory.slug,
      name: studioDirectory.name,
      type: studioDirectory.type,
      avatarUrl: studioDirectory.avatarUrl,
      region: studioDirectory.region,
      role: studioDirectoryMembers.role,
      memberCount: sql<number>`(
        SELECT count(*)::int FROM ${studioDirectoryMembers} m
        WHERE m.studio_id = ${studioDirectory.studioId} AND m.deleted_at IS NULL
      )`,
      createdAt: studioDirectory.createdAt,
    })
    .from(studioDirectoryMembers)
    .innerJoin(studioDirectory, eq(studioDirectory.studioId, studioDirectoryMembers.studioId))
    .where(
      and(
        eq(studioDirectoryMembers.userId, userId),
        isNull(studioDirectoryMembers.deletedAt),
        isNull(studioDirectory.deletedAt),
        eq(studioDirectory.state, "live"),
      ),
    )
    .orderBy(studioDirectory.createdAt);
}

/**
 * The regions other than the global one where a user has members or notifications.
 * @param userId - The user.
 * @returns The region codes.
 */
export async function listUserRegions(userId: string): Promise<string[]> {
  const rows = await db
    .select({ region: userRegions.region })
    .from(userRegions)
    .where(eq(userRegions.userId, userId));
  return rows.map((row) => row.region);
}

/**
 * Record what a region's Studios use, keeping only reports newer than the
 * one already held for each Studio and region.
 * @param region - The reporting region.
 * @param asOf - When the region measured.
 * @param usage - Bytes per Studio.
 * @param tx - The recording transaction.
 */
export async function recordRegionUsage(
  region: string,
  asOf: Date,
  usage: readonly { studioId: string; bytes: number }[],
  tx: DbTx,
): Promise<void> {
  if (usage.length === 0) return;
  await tx
    .insert(studioStorageUsageGlobal)
    .values(usage.map((entry) => ({ studioId: entry.studioId, region, bytes: entry.bytes, asOf })))
    .onConflictDoUpdate({
      target: [studioStorageUsageGlobal.studioId, studioStorageUsageGlobal.region],
      set: { bytes: sql`excluded.bytes`, asOf: sql`excluded.as_of`, updatedAt: new Date() },
      setWhere: sql`excluded.as_of > ${studioStorageUsageGlobal.asOf}`,
    });
}

/**
 * What an admin's Studios use in every region but one, as the regions last reported.
 * @param adminUserId - The admin.
 * @param exceptRegion - The region whose usage the caller reads live.
 * @returns The bytes.
 */
export async function sumUsageElsewhere(adminUserId: string, exceptRegion: string): Promise<number> {
  const [row] = await db
    .select({ bytes: sql<string>`COALESCE(SUM(${studioStorageUsageGlobal.bytes}), 0)::text` })
    .from(studioStorageUsageGlobal)
    .innerJoin(studioDirectory, eq(studioDirectory.studioId, studioStorageUsageGlobal.studioId))
    .where(
      and(
        eq(studioDirectory.adminUserId, adminUserId),
        isNull(studioDirectory.deletedAt),
        sql`${studioStorageUsageGlobal.region} <> ${exceptRegion}`,
      ),
    );
  return Number(row?.bytes ?? 0);
}

/** A slug reservation whose rename the sweep should settle. */
export interface DueSlugReservation {
  slug: string;
  studioId: string;
  region: string | null;
}

/**
 * Slug reservations past their `expires_at`, with the Studio's region.
 * @param limit - The most to return.
 * @returns Them, oldest first.
 */
export async function listDueSlugReservations(limit: number): Promise<DueSlugReservation[]> {
  return db
    .select({ slug: slugReservations.slug, studioId: slugReservations.studioId, region: studioDirectory.region })
    .from(slugReservations)
    .innerJoin(studioDirectory, eq(studioDirectory.studioId, slugReservations.studioId))
    .where(and(isNull(slugReservations.deletedAt), lte(slugReservations.expiresAt, sql`now()`)))
    .orderBy(slugReservations.expiresAt)
    .limit(limit);
}
