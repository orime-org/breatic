// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The global directory of Studios (inner#1955), the one record of who pays
 * for each Studio. Runs in the global region; other regions reach it through
 * the global API.
 */

import { db, env, isDeadlock, isGlobalRegion, projectsRepo, regionOutboxRepo, studioDirectoryRepo, type DbTx } from "@breatic/core";
import * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";
import * as usersRepo from "@domain/auth/user.repo.js";
import { releaseDesignations } from "@domain/credit/creditLot.service.js";
import { applySnapshot, type StudioSnapshot } from "@domain/region/regionOutboxApply.service.js";
import * as studioRepo from "@domain/studio/studio.repo.js";
import * as studioTransfersRepo from "@domain/studio/studioTransfers.repo.js";

/** What one admin change asks for. */
export interface AdminChange {
  studioId: string;
  fromUserId: string;
  toUserId: string;
  /** Names the change, so a retry of the same one answers as the first did. */
  changeId: string;
}

/** How an admin change ended. */
export type AdminChangeResult = { changed: true } | { changed: false; reason: "admin_mismatch" };

/**
 * Move a Studio's admin in the directory, the only writer of that admin.
 *
 * The directory row is locked first. The change applied last answers
 * `changed` again when it is retried; any other change applies only from the
 * admin it names, and releases that admin's designations to the Studio in the
 * same transaction, so the Studio never spends the money of someone who has
 * already handed it over.
 * @param change - Which Studio, from whom to whom, and the change id.
 * @param tx - A transaction to run in; one is opened when absent.
 * @returns Whether the admin is now the requested one.
 */
export async function changeDirectoryAdmin(change: AdminChange, tx?: DbTx): Promise<AdminChangeResult> {
  /**
   * Apply the change in one transaction.
   * @param inner - The transaction.
   * @returns How the change ended.
   */
  const run = async (inner: DbTx): Promise<AdminChangeResult> => {
    const row = await studioDirectoryRepo.lockRow(change.studioId, inner);
    if (row !== null && row.lastAdminChangeId === change.changeId) return { changed: true };
    if (row === null || row.adminUserId !== change.fromUserId) return { changed: false, reason: "admin_mismatch" };
    await studioDirectoryRepo.setAdmin(change.studioId, change.toUserId, change.changeId, inner);
    await releaseDesignations({ userId: change.fromUserId, studioId: change.studioId, tx: inner });
    return { changed: true };
  };
  return tx === undefined ? db.transaction(run) : run(tx);
}

/**
 * Send a Studio's whole current state to the directory (inner#1955): its
 * profile, members, Projects and open transfer offer, as one `studio.snapshot`
 * event on the same ordered channel as every other change, so a change after
 * it still wins. The back office repairs a directory row with it, through
 * the global region's internal API; the directory admin is left to
 * `changeDirectoryAdmin`.
 * @param studioId - A Studio in this region.
 * @returns Once the snapshot is written.
 */
export async function emitStudioSnapshot(studioId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // The Studio row first, the lock every `studio:{id}` event takes.
    await studioRepo.lockStudio(studioId, tx);
    const studio = await studioRepo.getById(studioId, tx);
    if (studio === null) return;
    const members = await studioMembersRepo.lockMembership(studioId, tx);
    const offer = await studioTransfersRepo.findLiveForContainer(studioId);
    const snapshot: StudioSnapshot = {
      studioId,
      slug: studio.slug,
      name: studio.name,
      avatarUrl: studio.avatarUrl,
      members: members.map((member) => ({ userId: member.userId, role: member.role })),
      projectIds: await projectsRepo.listIdsInStudio(studioId, tx),
      transferPendingUntil: offer === null ? null : offer.expiresAt.toISOString(),
    };
    if (isGlobalRegion(env)) await applySnapshot(snapshot, tx);
    else {
      await regionOutboxRepo.append(
        { aggregateKey: `studio:${studioId}`, eventType: "studio.snapshot", payload: { ...snapshot } },
        tx,
      );
    }
  });
}

/** How a user is shown: their personal Studio's name, handle and avatar, and their address. */
export interface Profile {
  /** The personal Studio's name; null before onboarding. */
  name: string | null;
  /** The personal Studio's slug, shown as `@handle`; null before onboarding. */
  handle: string | null;
  avatarUrl: string | null;
  /** The account's address; null when the account is gone. */
  email: string | null;
  /** Whether the personal Studio named here was deleted; a live one always wins. */
  deleted: boolean;
}

/**
 * How each of these users is shown, from the directory's personal Studio
 * rows and the accounts (inner#1955). Runs in the global region.
 * @param userIds - The users.
 * @returns Each known user's profile, keyed by user id.
 */
export async function getProfiles(userIds: readonly string[]): Promise<Record<string, Profile>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return {};
  const [rows, accounts] = await Promise.all([
    studioDirectoryRepo.listPersonalByCreators(ids),
    usersRepo.getUsersByIds(ids),
  ]);
  const profiles: Record<string, Profile> = {};
  for (const account of accounts) {
    profiles[account.id] = { name: null, handle: null, avatarUrl: null, email: account.email, deleted: false };
  }
  for (const row of rows) {
    const held = profiles[row.createdByUserId];
    if (held !== undefined && held.name !== null && !held.deleted) continue;
    profiles[row.createdByUserId] = {
      name: row.name,
      handle: row.slug,
      avatarUrl: row.avatarUrl,
      email: held?.email ?? null,
      deleted: row.deletedAt !== null,
    };
  }
  return profiles;
}

/**
 * Align the directory with the region tables once, after the global region's
 * upgrade (inner#1955). Old processes running during the upgrade wrote
 * Studios, members, Projects, transfers and removals to the region tables
 * only; once they have all exited, this runs one short transaction per
 * Studio, in the order every `studio:{id}` writer locks (the Studio row, its
 * members, then the directory row), and retries only that Studio on a
 * deadlock. A mismatched admin moves only through
 * {@link changeDirectoryAdmin}, which releases the old admin's designations;
 * a Studio with an accepting transfer keeps its directory admin. The
 * completion mark makes a second run do nothing, and it does nothing outside
 * the global region, whose directory tables are the only ones in use.
 * @returns How many Studios it aligned, or 0 when it had already run or runs outside the global region.
 */
export async function reconcileDirectoryAfterUpgrade(): Promise<number> {
  if (!isGlobalRegion(env) || (await studioDirectoryRepo.isReconciled())) return 0;
  // Newest first: the Studios old processes created during the upgrade are
  // the ones missing from the directory altogether.
  const studioIds = await studioRepo.listLiveIds();
  for (const studioId of studioIds) {
    for (;;) {
      try {
        await reconcileStudio(studioId);
        break;
      } catch (err) {
        if (!isDeadlock(err)) throw err;
      }
    }
  }
  await studioDirectoryRepo.markReconciled();
  return studioIds.length;
}

/**
 * Align one Studio's directory row, members, Projects and open offer with the
 * region tables.
 * @param studioId - The Studio.
 * @returns Once its transaction commits.
 */
async function reconcileStudio(studioId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await studioRepo.lockStudio(studioId, tx);
    const studio = await studioRepo.getById(studioId, tx);
    if (studio === null) return;
    const members = await studioMembersRepo.lockMembership(studioId, tx);
    const admin = members.find((member) => member.role === "admin")?.userId ?? studio.createdByUserId;
    const row = await studioDirectoryRepo.lockRow(studioId, tx);
    if (row === null) {
      await studioDirectoryRepo.insertRow(
        {
          studioId,
          slug: studio.slug,
          region: null,
          type: studio.type,
          name: studio.name,
          adminUserId: admin,
          createdByUserId: studio.createdByUserId,
          state: "live",
        },
        tx,
      );
    }
    await studioDirectoryRepo.updateProfile(studioId, { name: studio.name, slug: studio.slug, avatarUrl: studio.avatarUrl }, tx);
    const current = new Set(members.map((member) => member.userId));
    for (const member of members) await studioDirectoryRepo.upsertMember(studioId, member.userId, member.role, tx);
    for (const held of await studioDirectoryRepo.listMembers(studioId, tx)) {
      if (!current.has(held.userId)) await studioDirectoryRepo.removeMember(studioId, held.userId, tx);
    }
    for (const projectId of await projectsRepo.listIdsInStudio(studioId, tx)) {
      await studioDirectoryRepo.recordProject(projectId, studioId, tx);
    }
    const offer = await studioTransfersRepo.findLiveForContainer(studioId);
    await studioDirectoryRepo.setTransferPendingUntil(studioId, offer?.expiresAt ?? null, tx);
    if (row !== null && row.adminUserId !== admin && !(await studioTransfersRepo.isAccepting(studioId, tx))) {
      await changeDirectoryAdmin(
        { studioId, fromUserId: row.adminUserId, toUserId: admin, changeId: `reconcile:${studioId}` },
        tx,
      );
    }
  });
}
