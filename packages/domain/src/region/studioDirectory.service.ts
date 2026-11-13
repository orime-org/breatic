// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The global directory of Studios (inner#1955), the one record of who pays
 * for each Studio. Runs in the global region; other regions reach it through
 * the global API.
 */

import { db, projectsRepo, regionOutboxRepo, studioDirectoryRepo, type DbTx } from "@breatic/core";
import * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";
import * as usersRepo from "@domain/auth/user.repo.js";
import { releaseDesignations } from "@domain/credit/creditLot.service.js";
import { inGlobalRegion } from "@domain/region/directory-writes.js";
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
 * it still wins. Used to repair a directory row and by the upgrade
 * reconciliation; the directory admin is left to `changeDirectoryAdmin`.
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
    if (inGlobalRegion()) await applySnapshot(snapshot, tx);
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
