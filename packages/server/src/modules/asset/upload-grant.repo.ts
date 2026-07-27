// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Upload-grant repository (#1826, design §2.2 / §3.2) — the anti-spoof
 * authority that REPLACES the prefix-based `isOwnedKey`.
 *
 * When /presign mints a tenant-neutral storage key K, it records one grant
 * (user + owner studio + declared content_hash + K). The upload endpoints then
 * re-derive ownership from this ledger instead of from a key prefix:
 *   - /local-upload (write-time gate) → {@link findLiveGrant}: a grant issued
 *     to this user + owner studio and NOT yet consumed authorises the disk
 *     write; it does NOT consume (a local upload is a two-hop PUT-then-report
 *     on ONE grant — consuming on the first hop would 422 the second);
 *   - /uploaded (registration terminal) → {@link consumeGrant}: the same
 *     ownership check, then a single-shot CAS that marks the grant consumed
 *     (anti-replay), run AFTER the studio_assets INSERT.
 *
 * Only the server upload path uses this table (the worker holds bytes and
 * registers directly, never issuing a grant), so the repo lives in `@server`,
 * not `@domain` — the `upload_grants` schema itself is defined centrally in
 * `@breatic/core` (the home of every table's schema).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, uploadGrants } from "@breatic/core";

/** A row of the upload-grant ledger. */
export interface UploadGrant {
  id: string;
  userId: string;
  studioId: string;
  /**
   * Client-declared sha256 hex. Always present: presign refuses a request
   * without one (#1826 §0 rule 4, "no hash, no upload"), so a grant can never
   * exist hashless.
   *
   * OWNERSHIP does not read it — that is (storage_key, user_id, not-consumed)
   * only, which is what lets `/local-upload` (a bare byte PUT with no hash in
   * scope) authorise a write. But an `/uploaded` REPORT must match it
   * (`resolveGrantForReport`, Gate-2 R7): a grant authorises one upload of one
   * piece of content, and letting a report name different content lets two
   * concurrent reports register two rows against a single key.
   */
  contentHash: string;
  storageKey: string;
  declaredSize: number;
  consumedAt: Date | null;
  createdAt: Date;
}

/**
 * Map a Drizzle row to an {@link UploadGrant}.
 * @param row - Raw row selected from `upload_grants`.
 * @returns The mapped grant.
 */
function toEntity(row: typeof uploadGrants.$inferSelect): UploadGrant {
  return {
    id: row.id,
    userId: row.userId,
    studioId: row.studioId,
    contentHash: row.contentHash,
    storageKey: row.storageKey,
    declaredSize: row.declaredSize,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Record a grant when /presign mints a storage key. The `storage_key` UNIQUE
 * guarantees a key is issued at most once, so a duplicate key throws.
 * @param input - The grant fields.
 * @param input.userId - The user who requested the presign.
 * @param input.studioId - The server-resolved owner studio.
 * @param input.contentHash - Client-declared sha256 hex. Mandatory since
 *   #1826 §0 rule 4 ("no hash, no upload"): presign refuses a hashless request
 *   outright, so a grant can never exist without one. Ownership checks ignore
 *   it; an `/uploaded` report must match it (see {@link UploadGrant}).
 * @param input.storageKey - The minted tenant-neutral key K.
 * @param input.declaredSize - Client-declared byte size (UX pre-check only).
 * @returns The persisted grant.
 * @throws {Error} When the storage key was already issued (UNIQUE violation).
 */
export async function issueGrant(input: {
  userId: string;
  studioId: string;
  contentHash: string;
  storageKey: string;
  declaredSize: number;
}): Promise<UploadGrant> {
  const rows = await db
    .insert(uploadGrants)
    .values({
      userId: input.userId,
      studioId: input.studioId,
      contentHash: input.contentHash,
      storageKey: input.storageKey,
      declaredSize: input.declaredSize,
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Resolve a LIVE grant (issued to this user, not yet consumed) WITHOUT
 * consuming it — the /local-upload write-time gate. Ownership = "was this key
 * issued to THIS user"; the storage key is globally unique, so it locates the
 * one row and the user_id decides ownership. The owner studio is READ OUT of
 * that row (recorded at presign), not supplied by the caller — /local-upload
 * (a bare byte PUT) has no project/studio. A forged key, a foreign user, or an
 * already-consumed grant resolves to null. No time limit (design v11): the
 * check is ownership + not-consumed only.
 * @param params - The ownership claim.
 * @param params.storageKey - The key the client is uploading to.
 * @param params.userId - The authenticated caller.
 * @returns The live grant (carrying the owner studio), or null when none matches.
 */
export async function findLiveGrant(params: {
  storageKey: string;
  userId: string;
}): Promise<UploadGrant | null> {
  const rows = await db
    .select()
    .from(uploadGrants)
    .where(
      and(
        eq(uploadGrants.storageKey, params.storageKey),
        eq(uploadGrants.userId, params.userId),
        isNull(uploadGrants.consumedAt),
      ),
    )
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Single-shot consume (anti-replay) — the /uploaded registration terminal. An
 * atomic CAS marks the grant consumed only if it is issued to this user and
 * still unconsumed; concurrent callers on one key see EXACTLY ONE win (PG row
 * lock re-evaluates the `consumed_at IS NULL` predicate). A replay, a foreign
 * user, or a forged key returns false. Ownership is user-only (same rationale
 * as {@link findLiveGrant}: the studio is recorded, not a query condition).
 * @param params - The ownership claim.
 * @param params.storageKey - The key being registered.
 * @param params.userId - The authenticated caller.
 * @returns True when this call consumed the grant; false otherwise.
 */
export async function consumeGrant(params: {
  storageKey: string;
  userId: string;
}): Promise<boolean> {
  const rows = await db
    .update(uploadGrants)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(uploadGrants.storageKey, params.storageKey),
        eq(uploadGrants.userId, params.userId),
        isNull(uploadGrants.consumedAt),
      ),
    )
    .returning({ id: uploadGrants.id });
  return rows.length > 0;
}
