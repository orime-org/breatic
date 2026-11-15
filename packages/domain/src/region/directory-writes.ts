// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Directory changes made by a region's business transactions (inner#1955).
 *
 * In the global region the transaction writes the directory itself; in every
 * other region it writes an outbox event, which the relay carries to the
 * global region in order. Either way the change commits with the business
 * write it describes.
 */

import { db, env, isGlobalRegion, regionOutboxRepo, studioDirectoryRepo, type DbTx } from "@breatic/core";
import * as studioRepo from "@domain/studio/studio.repo.js";

/**
 * Record that a Studio's transfer offer opened, until its expiry.
 * @param studioId - The Studio, locked by the caller.
 * @param until - The offer's expiry.
 * @param tx - The transaction the offer is filed in.
 */
export async function transferOpened(studioId: string, until: Date, tx: DbTx): Promise<void> {
  if (isGlobalRegion(env)) {
    await studioDirectoryRepo.setTransferPendingUntil(studioId, until, tx);
    return;
  }
  await regionOutboxRepo.append(
    { aggregateKey: `studio:${studioId}`, eventType: "studio.transfer_opened", payload: { studioId, until: until.toISOString() } },
    tx,
  );
}

/**
 * Record that a Studio's transfer offer ended, however it ended.
 * @param studioId - The Studio, locked by the caller.
 * @param tx - The transaction the offer ends in.
 */
export async function transferClosed(studioId: string, tx: DbTx): Promise<void> {
  if (isGlobalRegion(env)) {
    await studioDirectoryRepo.setTransferPendingUntil(studioId, null, tx);
    return;
  }
  await regionOutboxRepo.append(
    { aggregateKey: `studio:${studioId}`, eventType: "studio.transfer_closed", payload: { studioId } },
    tx,
  );
}

/**
 * Record or emit a directory change: written straight to the directory in the
 * global region, as an outbox event everywhere else.
 * @param aggregateKey - What the event is ordered under.
 * @param eventType - The event.
 * @param payload - Its facts.
 * @param tx - The business transaction.
 * @param here - How the global region writes the same change.
 */
async function change(
  aggregateKey: string,
  eventType: string,
  payload: Record<string, unknown>,
  tx: DbTx,
  here: () => Promise<void>,
): Promise<void> {
  if (isGlobalRegion(env)) await here();
  else await regionOutboxRepo.append({ aggregateKey, eventType, payload }, tx);
}

/**
 * Record a Studio's new name, avatar or slug.
 * @param studioId - The Studio, locked by the caller.
 * @param profile - What changed.
 * @param profile.name - Its new name.
 * @param profile.avatarUrl - Its new avatar, or null to clear it.
 * @param profile.slug - Its new slug.
 * @param tx - The business transaction.
 */
export async function profileChanged(
  studioId: string,
  profile: { name?: string; avatarUrl?: string | null; slug?: string },
  tx: DbTx,
): Promise<void> {
  await change(`studio:${studioId}`, "studio.profile_changed", { studioId, ...profile }, tx, () =>
    studioDirectoryRepo.updateProfile(studioId, profile, tx),
  );
}

/**
 * Record a member joining a Studio or changing role.
 * @param studioId - The Studio, locked by the caller.
 * @param userId - The member.
 * @param role - Their role now.
 * @param tx - The business transaction.
 */
export async function memberUpserted(studioId: string, userId: string, role: string, tx: DbTx): Promise<void> {
  await change(`studio:${studioId}`, "studio_member.upserted", { studioId, userId, role }, tx, () =>
    studioDirectoryRepo.upsertMember(studioId, userId, role, tx),
  );
  await userRegionTouched(userId, tx);
}

/**
 * Record a member leaving a Studio.
 * @param studioId - The Studio, locked by the caller.
 * @param userId - The former member.
 * @param tx - The business transaction.
 */
export async function memberRemoved(studioId: string, userId: string, tx: DbTx): Promise<void> {
  await change(`studio:${studioId}`, "studio_member.removed", { studioId, userId }, tx, () =>
    studioDirectoryRepo.removeMember(studioId, userId, tx),
  );
}

/**
 * Record a new Project's Studio.
 * @param projectId - The Project.
 * @param studioId - Its Studio.
 * @param tx - The creating transaction.
 */
export async function projectCreated(projectId: string, studioId: string, tx: DbTx): Promise<void> {
  await change(`project:${projectId}`, "project.created", { projectId, studioId }, tx, () =>
    studioDirectoryRepo.recordProject(projectId, studioId, tx),
  );
}

/**
 * Record that a user has members or notifications in this region, so the
 * global region's cross-region reads ask it. The global region needs no record
 * of its own.
 * @param userId - The user.
 * @param tx - The writing transaction, when there is one.
 */
export async function userRegionTouched(userId: string, tx?: DbTx): Promise<void> {
  if (isGlobalRegion(env)) return;
  await regionOutboxRepo.append({ aggregateKey: `user:${userId}`, eventType: "user_region.touched", payload: { userId } }, tx);
}

/**
 * Hold a new slug in the global directory for a rename. In the global region
 * the rename's own transaction checks the slug (see {@link slugFreeHere}).
 * A retry of a rename whose first answer was lost finds the Studio's own
 * reservation and is answered held again. The Studio's own directory row
 * showing the slug is no hold: it may be a rename the outbox has not
 * carried yet, about to move off the slug.
 * @param slug - The new slug.
 * @param studioId - The Studio being renamed.
 * @returns Whether the slug is now held for the Studio.
 */
export async function reserveSlug(slug: string, studioId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await studioDirectoryRepo.lockSlug(slug, tx);
    if (await studioDirectoryRepo.isSlugHeld(slug, tx, studioId)) return false;
    // A reused reservation is held for another window, so a sweep that asked
    // the region before this rename leaves it alone.
    if (await studioDirectoryRepo.hasReservation(slug, studioId, tx)) await studioDirectoryRepo.extendReservation(slug, studioId, tx);
    else await studioDirectoryRepo.reserveSlug(slug, studioId, tx);
    return true;
  });
}

/** What a Studio's region says about its slug, for settling a reservation. */
export interface SlugState {
  /** The slug the region holds, or null when the Studio is gone. */
  slug: string | null;
  /** Whether the region still has events of the Studio to deliver. */
  eventsInFlight: boolean;
}

/**
 * The slug a Studio in this region holds, and whether events of the Studio
 * are still on their way to the global region. The slug is read first: a
 * rename after it leaves an unsent event behind.
 * @param studioId - The Studio.
 * @returns Its slug state.
 */
export async function slugState(studioId: string): Promise<SlugState> {
  const slug = (await studioRepo.getById(studioId))?.slug ?? null;
  return { slug, eventsInFlight: await regionOutboxRepo.hasUnsent(`studio:${studioId}`) };
}

/**
 * Settle a reservation the sweep found past due, from what the Studio's
 * region says. The sweep never writes the directory: the region's ordered
 * outbox (or a repair snapshot) does. While events of the Studio are on their
 * way one of them may carry the slug, so it stays; after that it stays while
 * the region holds it and the directory does not show it yet, and goes
 * otherwise. Under the slug's lock, a reservation a rename reused since the
 * region answered is no longer due and is left alone.
 * @param slug - The reserved slug.
 * @param studioId - The Studio.
 * @param region - What the Studio's region says.
 * @returns Once settled.
 */
export async function settleSlugReservation(slug: string, studioId: string, region: SlugState): Promise<void> {
  await db.transaction(async (tx) => {
    await studioDirectoryRepo.lockSlug(slug, tx);
    if (!(await studioDirectoryRepo.isReservationDue(slug, studioId, tx))) return;
    const keep =
      region.eventsInFlight || (region.slug === slug && (await studioDirectoryRepo.lockRow(studioId, tx))?.slug !== slug);
    if (keep) await studioDirectoryRepo.extendReservation(slug, studioId, tx);
    else await studioDirectoryRepo.releaseSlugReservation(slug, studioId, tx);
  });
}

/**
 * Hold a due reservation whose Studio's region did not answer for another
 * window, so it stays held and the next sweep reaches the reservations of
 * regions that do answer first.
 * @param slug - The reserved slug.
 * @param studioId - The Studio.
 * @returns Once postponed, or at once when it is no longer due.
 */
export async function postponeSlugReservation(slug: string, studioId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await studioDirectoryRepo.lockSlug(slug, tx);
    if (await studioDirectoryRepo.isReservationDue(slug, studioId, tx)) await studioDirectoryRepo.extendReservation(slug, studioId, tx);
  });
}

/**
 * In the global region, whether a rename may take a slug: checked under the
 * slug's lock in the rename's own transaction.
 * @param slug - The new slug.
 * @param tx - The rename's transaction.
 * @returns True when nobody holds it.
 */
export async function slugFreeHere(slug: string, tx: DbTx): Promise<boolean> {
  await studioDirectoryRepo.lockSlug(slug, tx);
  return !(await studioDirectoryRepo.isSlugHeld(slug, tx));
}
