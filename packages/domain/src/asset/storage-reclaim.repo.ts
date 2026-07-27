// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Storage-reclaim queue repository (#1826 design §2.3) — data access for
 * `storage_reclaim_queue`, the work list the OFFLINE reclaim job reads.
 *
 * Runtime never deletes a physical object (§0 rule 1 — that is what keeps the
 * delete attack surface at zero). So when a within-studio dedup hit makes the
 * copy we just stored redundant, runtime does the one thing it may: INSERT a
 * row here saying "this object is a known duplicate, safe to reclaim". The
 * offline job then works from an explicit list instead of scanning the bucket
 * guessing which objects are orphans.
 *
 * Reclaiming a queued object is safe by construction: every consumer URL comes
 * from the SURVIVING row's canonical (§0 rule 2), so nothing live points at it.
 */

import { sql } from "drizzle-orm";
import { db } from "@breatic/core";
import type { StudioAssetEntity } from "@breatic/shared";

/** One redundant object to hand to the offline reclaim job. */
export interface ReclaimEntry {
  /** The redundant object (the copy this request just stored). */
  storageKey: string;
  /** Its content fingerprint — identical to the surviving row's. */
  contentHash: string;
  /** Owning studio (quota / reconciliation audits). */
  studioId: string;
  /** The key that WON dedup and stays live (the offline job's safety rail). */
  keptStorageKey: string;
  /**
   * The asset's own source — mirrors `studio_assets.source`, so the offline job
   * can tell a worker-produced duplicate from a browser-uploaded one. The three
   * possible values are 'ai' (worker output), 'upload' (browser upload, which
   * includes a frontend mini-tool product — the wire's `mini_tool` sub-type is
   * an activity-feed distinction that never reaches this column) and 'cover'
   * (a video's cover, reachable from BOTH paths).
   */
  source: StudioAssetEntity["source"];
}

/**
 * Queue a redundant object for offline reclaim. Idempotent: re-reporting the
 * same object (a retried upload report) hits the `storage_key` unique index and
 * does nothing, so the queue never grows duplicates.
 *
 * TWO things can never be queued, and both are enforced HERE rather than at the
 * call sites, because what this queue lists is what an offline job will delete:
 *
 * 1. The winner itself. The caller only ever queues a key that LOST dedup, so
 *    `storageKey !== keptStorageKey` already holds; guarded anyway because
 *    queueing the surviving key would delete live content.
 * 2. Any key that STILL HAS A LIVE LEDGER ROW. `studio_assets` is unique on
 *    (studio_id, content_hash) but NOT on storage_key, so one key can hold a
 *    live row under hash A while a second registration deduplicates it against
 *    hash B and offers it up as a loser (Gate-2 R7). The upload route makes
 *    that unreachable by binding each grant to one content hash, but this is
 *    the last check before an offline job deletes bytes, so it verifies the
 *    property itself instead of trusting every present and future caller to.
 *    The check rides INSIDE the INSERT (`WHERE NOT EXISTS`) so it is atomic —
 *    a read-then-insert would reintroduce the very race it exists to close.
 *
 * Refusing to queue is not an error: the registration it accompanies has
 * already succeeded, and an un-queued object is simply one the offline sweep
 * has to find on its own.
 * @param entry - The redundant object plus the winner it deduped against.
 * @throws {Error} When the insert fails for any reason other than the conflict.
 */
export async function queueForReclaim(entry: ReclaimEntry): Promise<void> {
  if (entry.storageKey === entry.keptStorageKey) return;
  await db.execute(sql`
    INSERT INTO storage_reclaim_queue
      (storage_key, content_hash, studio_id, kept_storage_key, source)
    SELECT ${entry.storageKey}, ${entry.contentHash}, ${entry.studioId}::uuid,
           ${entry.keptStorageKey}, ${entry.source}
    WHERE NOT EXISTS (
      SELECT 1 FROM studio_assets
      WHERE storage_key = ${entry.storageKey} AND deleted_at IS NULL
    )
    ON CONFLICT (storage_key) DO NOTHING
  `);
}
