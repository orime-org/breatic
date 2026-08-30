// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/**
 * A row of the upload-grant ledger.
 *
 * The grant is the only thing that survives between signing a ticket and
 * hearing back from the ingest Worker, so it carries everything the report
 * handler will need — and everything the sweep will need if no report ever
 * arrives. The context fields travelled up from the browser when it asked for
 * the ticket and were checked against that user's access before landing here,
 * which is why the report may trust them.
 *
 * There is no content hash on it any more. The hash that names the content is
 * the one the Worker computes over the bytes that really landed; a column
 * holding the client's claim would be a column someone reads by mistake.
 */
export interface UploadGrant {
  id: string;
  userId: string;
  studioId: string;
  storageKey: string;
  declaredSize: number;
  consumedAt: Date | null;
  /** Set when this grant died without its bytes ever becoming an asset. */
  voidedAt: Date | null;
  /** How long the browser has to start the upload. */
  expiresAt: Date;
  /** The node's fencing gen; an event without it is dropped by collab's CAS. */
  leaseGen: number;
  nodeId: string | null;
  projectId: string | null;
  spaceId: string | null;
  source: string | null;
  toolName: string | null;
  derived: boolean | null;
  filename: string | null;
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
    storageKey: row.storageKey,
    declaredSize: row.declaredSize,
    consumedAt: row.consumedAt,
    voidedAt: row.voidedAt,
    expiresAt: row.expiresAt,
    leaseGen: row.leaseGen,
    nodeId: row.nodeId,
    projectId: row.projectId,
    spaceId: row.spaceId,
    source: row.source,
    toolName: row.toolName,
    derived: row.derived,
    filename: row.filename,
    createdAt: row.createdAt,
  };
}

/**
 * Record a grant when the ticket endpoint mints a storage key. The
 * `storage_key` UNIQUE guarantees a key is issued at most once, so a duplicate
 * key throws.
 * @param input - The grant fields.
 * @param input.userId - The user who asked for the ticket.
 * @param input.studioId - The server-resolved owner studio.
 * @param input.storageKey - The minted tenant-neutral key K.
 * @param input.declaredSize - Client-declared byte size (UX pre-check only).
 * @param input.expiresAt - When the ticket stops being usable.
 * @param input.leaseGen - The node's fencing gen at the moment handling opened.
 * @param input.context - Where these bytes are going and what started them.
 * @param input.context.nodeId - Node the bytes land on, when there is one.
 * @param input.context.projectId - Project that node belongs to.
 * @param input.context.spaceId - Canvas space holding that node.
 * @param input.context.source - What started this upload.
 * @param input.context.toolName - Mini-tool that produced the bytes, if any.
 * @param input.context.derived - True when the bytes came out of another asset.
 * @param input.context.filename - Original file name, shown in history.
 * @returns The persisted grant.
 * @throws {Error} When the storage key was already issued (UNIQUE violation).
 */
export async function issueGrant(input: {
  userId: string;
  studioId: string;
  storageKey: string;
  declaredSize: number;
  expiresAt: Date;
  leaseGen: number;
  context: {
    nodeId?: string | null;
    projectId?: string | null;
    spaceId?: string | null;
    source?: string | null;
    toolName?: string | null;
    derived?: boolean | null;
    filename?: string | null;
  };
}): Promise<UploadGrant> {
  const rows = await db
    .insert(uploadGrants)
    .values({
      userId: input.userId,
      studioId: input.studioId,
      storageKey: input.storageKey,
      declaredSize: input.declaredSize,
      expiresAt: input.expiresAt,
      leaseGen: input.leaseGen,
      nodeId: input.context.nodeId ?? null,
      projectId: input.context.projectId ?? null,
      spaceId: input.context.spaceId ?? null,
      source: input.context.source ?? null,
      toolName: input.context.toolName ?? null,
      derived: input.context.derived ?? null,
      filename: input.context.filename ?? null,
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
        // A voided grant is as dead as a consumed one: the sweep declared
        // this upload over and the node was already told it failed. Without
        // this a report arriving after the sweep would register an asset for
        // a node that has moved on.
        isNull(uploadGrants.voidedAt),
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
        isNull(uploadGrants.voidedAt),
      ),
    )
    .returning({ id: uploadGrants.id });
  return rows.length > 0;
}
