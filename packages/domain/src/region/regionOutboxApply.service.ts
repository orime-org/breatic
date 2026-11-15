// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Applying a region's outbox events in the global region (inner#1955). Each
 * aggregate's events apply in id order and at most once: the last applied id
 * is kept per region and aggregate, in the same transaction as the change.
 */

import { db, isUniqueViolation, regionOutboxAppliedRepo, studioDirectoryRepo, type DbTx } from "@breatic/core";
import type { OutboxEvent } from "@domain/region/regionOutbox.service.js";

/** A snapshot of one Studio as its region holds it. */
export interface StudioSnapshot {
  studioId: string;
  slug: string;
  name: string;
  avatarUrl: string | null;
  members: { userId: string; role: string }[];
  projectIds: string[];
  transferPendingUntil: string | null;
}

/** SQLSTATEs meaning the event's facts can never hold here. */
const PERMANENT = new Set(["23502", "23503", "23514", "22P02"]);

/**
 * Whether a failure is one the event can never get past.
 * @param err - The failure.
 * @returns True for a data constraint the event violates.
 */
function isPermanent(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur === "object" && "code" in cur && typeof cur.code === "string" && PERMANENT.has(cur.code)) return true;
    cur = typeof cur === "object" && "cause" in cur ? cur.cause : null;
  }
  return isUniqueViolation(err);
}

/**
 * Apply one event a region sent.
 * @param region - The region it came from.
 * @param event - The event.
 * @returns `applied`, `duplicate` when it or a later one was applied before,
 *   or `permanent_failure` when its facts can never hold.
 * @throws {Error} On a failure a retry may get past.
 */
export async function applyRegionEvent(
  region: string,
  event: OutboxEvent,
): Promise<"applied" | "duplicate" | "permanent_failure"> {
  try {
    return await db.transaction(async (tx) => {
      const id = Number(event.id);
      const last = await regionOutboxAppliedRepo.lockLastApplied(region, event.aggregateKey, tx);
      if (last !== null && id <= last) return "duplicate";
      if (!(await apply(region, event, tx))) return "permanent_failure";
      await regionOutboxAppliedRepo.setLastApplied(region, event.aggregateKey, id, tx);
      return "applied";
    });
  } catch (err) {
    if (isPermanent(err)) return "permanent_failure";
    throw err;
  }
}

/**
 * Write one event's change to the directory.
 * @param region - The region it came from.
 * @param event - The event.
 * @param tx - The applying transaction.
 * @returns False when the event's type is unknown.
 */
async function apply(region: string, event: OutboxEvent, tx: DbTx): Promise<boolean> {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "studio.profile_changed":
    case "studio.slug_changed": {
      const profile: { name?: string; avatarUrl?: string | null; slug?: string } = {};
      if (typeof p.name === "string") profile.name = p.name;
      if (typeof p.slug === "string") profile.slug = p.slug;
      if (p.avatarUrl === null || typeof p.avatarUrl === "string") profile.avatarUrl = p.avatarUrl;
      // The rename's reservation stays: a later rename of the same Studio
      // back to this slug may still rely on it, and the slug sweep lets it
      // go once the region's own slug says which one stands.
      await studioDirectoryRepo.updateProfile(String(p.studioId), profile, tx);
      return true;
    }
    case "studio_member.upserted":
      await studioDirectoryRepo.upsertMember(String(p.studioId), String(p.userId), String(p.role), tx);
      return true;
    case "studio_member.removed":
      await studioDirectoryRepo.removeMember(String(p.studioId), String(p.userId), tx);
      return true;
    case "studio.transfer_opened":
      await studioDirectoryRepo.setTransferPendingUntil(String(p.studioId), new Date(String(p.until)), tx);
      return true;
    case "studio.transfer_closed":
      await studioDirectoryRepo.setTransferPendingUntil(String(p.studioId), null, tx);
      return true;
    case "project.created":
      await studioDirectoryRepo.recordProject(String(p.projectId), String(p.studioId), tx);
      return true;
    case "user_region.touched":
      await studioDirectoryRepo.touchUserRegion(String(p.userId), region, tx);
      return true;
    case "studio.snapshot":
      await applySnapshot(p as unknown as StudioSnapshot, tx, region);
      return true;
    default:
      return false;
  }
}

/**
 * Rewrite a Studio's directory rows from its region's snapshot, all but the
 * admin, which only `changeDirectoryAdmin` writes. A snapshot another region
 * sent also records that region for each member, as each member's own
 * `user_region.touched` did.
 * @param snapshot - The Studio as its region holds it.
 * @param tx - The applying transaction.
 * @param region - The region that sent it, or none in the global region.
 */
export async function applySnapshot(snapshot: StudioSnapshot, tx: DbTx, region?: string): Promise<void> {
  await studioDirectoryRepo.updateProfile(
    snapshot.studioId,
    { name: snapshot.name, slug: snapshot.slug, avatarUrl: snapshot.avatarUrl },
    tx,
  );
  await studioDirectoryRepo.setTransferPendingUntil(
    snapshot.studioId,
    snapshot.transferPendingUntil === null ? null : new Date(snapshot.transferPendingUntil),
    tx,
  );
  const kept = new Set(snapshot.members.map((member) => member.userId));
  for (const member of await studioDirectoryRepo.listMembers(snapshot.studioId, tx)) {
    if (!kept.has(member.userId)) await studioDirectoryRepo.removeMember(snapshot.studioId, member.userId, tx);
  }
  for (const member of snapshot.members) {
    await studioDirectoryRepo.upsertMember(snapshot.studioId, member.userId, member.role, tx);
    if (region !== undefined) await studioDirectoryRepo.touchUserRegion(member.userId, region, tx);
  }
  for (const projectId of snapshot.projectIds) {
    await studioDirectoryRepo.recordProject(projectId, snapshot.studioId, tx);
  }
}
