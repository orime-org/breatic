// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload-grant repository (#1826, design §2.2 / §3.2) — the anti-spoof
 * authority that REPLACES the prefix-based `isOwnedKey`.
 *
 * When the ticket endpoint mints a tenant-neutral storage key K, it records one
 * grant (user + owner studio + K + where the bytes land). The report endpoint then
 * re-derives ownership from this ledger instead of from a key prefix: the ingest
 * Worker's report (registration terminal) reaches {@link consumeGrant}, which checks
 * ownership and then runs a single-shot CAS marking the grant consumed
 * (anti-replay), AFTER the studio_assets INSERT.
 *
 * Both server and worker issue grants now (#181: the worker's own bytes reach
 * R2 through the same ingest Worker, so they need the same ledger row), which
 * is why this lives in `@domain` — collab never touches it. The `upload_grants`
 * schema itself is defined centrally in `@breatic/core` (the home of every
 * table's schema), and this is still the only place that reads or writes it.
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, uploadGrants } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { ConsentSnapshot, StudioAssetEntity } from "@breatic/shared";

/**
 * What a grant says its upload is: an asset source, or `"transfer"` for a
 * request body moved through storage (inner#1006), which never becomes an
 * asset row.
 */
export type GrantAssetSource = StudioAssetEntity["source"] | "transfer";

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
  /** The ledger row the bytes registered as, set with `consumedAt`. */
  assetId: string | null;
  /** Why the grant was voided, set with `voidedAt`. */
  failureReason: string | null;
  /** How long the browser has to start the upload. */
  expiresAt: Date;
  /** Node these bytes land on. Null for a focus crop, which has no node. */
  nodeId: string | null;
  projectId: string | null;
  spaceId: string | null;
  source: string | null;
  toolName: string | null;
  derived: boolean | null;
  filename: string | null;
  /**
   * What the asset this grant produces is, in the ledger's own values (see
   * `StudioAssetEntity["source"]`), or `"transfer"`. Null means an ordinary
   * upload.
   */
  assetSource: GrantAssetSource | null;
  /** The generation whose output these bytes are, when they are one. */
  generationTaskId: string | null;
  /** The uploading browser's analytics consent when the ticket was issued (inner#1442 §4.4.5). */
  analyticsConsent: ConsentSnapshot | null;
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
    assetId: row.assetId,
    failureReason: row.failureReason,
    expiresAt: row.expiresAt,
    nodeId: row.nodeId,
    projectId: row.projectId,
    spaceId: row.spaceId,
    source: row.source,
    toolName: row.toolName,
    derived: row.derived,
    filename: row.filename,
    // Read back as the ledger's own values. Only our own code writes
    // this column, and it writes what `register` accepts.
    assetSource: row.assetSource as GrantAssetSource | null,
    generationTaskId: row.generationTaskId,
    analyticsConsent: row.analyticsConsent,
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
 * @param input.context - Where these bytes are going and what started them.
 * @param input.context.nodeId - Node the bytes land on, when there is one.
 * @param input.context.projectId - Project that node belongs to.
 * @param input.context.spaceId - Canvas space holding that node.
 * @param input.context.source - What started this upload.
 * @param input.context.toolName - Mini-tool that produced the bytes, if any.
 * @param input.context.derived - True when the bytes came out of another asset.
 * @param input.context.filename - Original file name, shown in history.
 * @param input.context.assetSource - What the resulting asset is, when this is
 *   not an ordinary upload.
 * @param input.context.generationTaskId - The generation that produced these
 *   bytes, when one did.
 * @param input.analyticsConsent - The uploading browser's analytics consent;
 *   absent reads as no consent.
 * @returns The persisted grant.
 * @throws {Error} When the storage key was already issued (UNIQUE violation).
 */
export async function issueGrant(input: {
  userId: string;
  studioId: string;
  storageKey: string;
  declaredSize: number;
  expiresAt: Date;
  context: {
    nodeId?: string | null;
    projectId?: string | null;
    spaceId?: string | null;
    source?: string | null;
    toolName?: string | null;
    derived?: boolean | null;
    filename?: string | null;
    assetSource?: GrantAssetSource | null;
    generationTaskId?: string | null;
  };
  analyticsConsent?: ConsentSnapshot;
}): Promise<UploadGrant> {
  const rows = await db
    .insert(uploadGrants)
    .values({
      userId: input.userId,
      studioId: input.studioId,
      storageKey: input.storageKey,
      declaredSize: input.declaredSize,
      expiresAt: input.expiresAt,
      nodeId: input.context.nodeId ?? null,
      projectId: input.context.projectId ?? null,
      spaceId: input.context.spaceId ?? null,
      source: input.context.source ?? null,
      toolName: input.context.toolName ?? null,
      derived: input.context.derived ?? null,
      filename: input.context.filename ?? null,
      assetSource: input.context.assetSource ?? null,
      generationTaskId: input.context.generationTaskId ?? null,
      analyticsConsent: input.analyticsConsent ?? null,
    })
    .returning();
  return toEntity(rows[0]!);
}

/** Why a key may not be finished right now. */
export type FinalizeRefusal = "no_grant" | "in_flight" | "already_registered";

/**
 * The answer to "may this upload finish on this key".
 *
 * A granted claim carries what the grant says the upload is, because the
 * finish that follows decides off it whether to read the media now (#299).
 */
export type FinalizeClaim =
  | { granted: true; assetSource: GrantAssetSource | null }
  | { granted: false; reason: FinalizeRefusal };

/**
 * Claim the exclusive permission to finish one upload on a key (#186, §6.4).
 *
 * What it stops is a replay of a ticket still inside its window. Measured on
 * real workerd: completing the same multipart upload twice throws, but opening
 * a NEW upload on a key already registered and completing that one silently
 * overwrites the object — and because dedup points other members of the studio
 * at that same key, the bytes they see are the ones written over.
 *
 * The upload id is what separates the two. A replay has to open its own
 * multipart upload, so it brings an id nobody recorded; a retry of the same
 * delivery brings the id the browser already holds, which is why three
 * deliveries of one report all get through.
 *
 * Registration does not end an upload's own claim on its key. The browser may
 * not have heard the answer, and its retry brings the same uploadId — for
 * which R2 refuses a second complete rather than writing anything, and the
 * repeated report is answered out of the ledger. Letting that one through is
 * how the retry finishes with the URL that was actually registered instead of
 * one this table would have to guess; dedup means the registered URL can name
 * an object under an entirely different key.
 *
 * One atomic CAS decides it: the row is updated only while the grant is not
 * voided and the key is either unclaimed or claimed by this very upload.
 * Concurrent askers see exactly one winner, the same way {@link consumeGrant}
 * does.
 * @param params - The key and the upload asking to finish on it.
 * @param params.storageKey - The key being finished.
 * @param params.uploadId - The multipart upload the caller holds.
 * @returns Granted, or the reason it was refused.
 */
export async function claimFinalize(params: {
  storageKey: string;
  uploadId: string;
}): Promise<FinalizeClaim> {
  const won = await db
    .update(uploadGrants)
    .set({ finalizingUploadId: params.uploadId })
    .where(
      and(
        eq(uploadGrants.storageKey, params.storageKey),
        isNull(uploadGrants.voidedAt),
        or(
          isNull(uploadGrants.finalizingUploadId),
          eq(uploadGrants.finalizingUploadId, params.uploadId),
        ),
      ),
    )
    .returning({ assetSource: uploadGrants.assetSource });
  if (won.length === 1) {
    return {
      granted: true,
      assetSource: (won[0]!.assetSource ?? null) as GrantAssetSource | null,
    };
  }

  // Losing the CAS says only "not you". Which of the three reasons it was
  // decides what the Worker tells the browser, so the row is read back.
  const grant = await findGrantByKey(params.storageKey);
  if (grant === null || grant.voidedAt !== null) {
    return { granted: false, reason: "no_grant" };
  }
  if (grant.consumedAt !== null) {
    return { granted: false, reason: "already_registered" };
  }
  return { granted: false, reason: "in_flight" };
}

/**
 * Single-shot consume (anti-replay) — the ingest report's registration terminal. An
 * atomic CAS marks the grant consumed only if it is issued to this user and
 * still unconsumed; concurrent callers on one key see EXACTLY ONE win (PG row
 * lock re-evaluates the `consumed_at IS NULL` predicate). A replay, a foreign
 * user, or a forged key returns false. Ownership is user-only: the studio is
 * recorded on the grant, not a query condition.
 * @param params - The ownership claim.
 * @param params.storageKey - The key being registered.
 * @param params.userId - The authenticated caller.
 * @param params.assetId - The ledger row the bytes registered as.
 * @returns True when this call consumed the grant; false otherwise.
 */
export async function consumeGrant(params: {
  storageKey: string;
  userId: string;
  assetId: string;
}): Promise<boolean> {
  const rows = await db
    .update(uploadGrants)
    .set({ consumedAt: sql`now()`, assetId: params.assetId })
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

/**
 * Mark a transfer grant complete (inner#1006): its bytes are stored and may
 * be referenced, and no asset row stands behind it, so `asset_id` stays null.
 *
 * Safe to run again: a grant already complete keeps its first `consumed_at`
 * and still answers true, so a rerun of the finish job changes nothing. A
 * voided grant, or one that is not a transfer, is left alone.
 * @param storageKey - The transfer's key.
 * @returns True when the grant is complete after this call; false when it is
 *   voided, not a transfer, or not there.
 */
export async function completeTransferGrant(storageKey: string): Promise<boolean> {
  const rows = await db
    .update(uploadGrants)
    .set({ consumedAt: sql`coalesce(${uploadGrants.consumedAt}, now())` })
    .where(
      and(
        eq(uploadGrants.storageKey, storageKey),
        eq(uploadGrants.assetSource, "transfer"),
        isNull(uploadGrants.voidedAt),
      ),
    )
    .returning({ id: uploadGrants.id });
  return rows.length > 0;
}

/**
 * Read a grant by its key alone, whatever state it is in.
 *
 * The report path needs the row in any state: a Durable Object retries until
 * we answer, so the second delivery of a report arrives against a grant this
 * server already consumed. Seeing that row is what lets the retry be answered
 * instead of refused.
 *
 * There is no user to check against here. The caller is the ingest Worker,
 * which proves nothing but that it holds the shared secret — every fact about
 * who this upload belongs to comes off the row itself.
 * @param storageKey - The key the report names.
 * @param tx - Optional transaction retained through maintenance admission.
 * @returns The grant, or null when no such key was ever issued.
 */
export async function findGrantByKey(
  storageKey: string,
  tx?: DbTx,
): Promise<UploadGrant | null> {
  const rows = await (tx ?? db)
    .select()
    .from(uploadGrants)
    .where(eq(uploadGrants.storageKey, storageKey))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * The grants among `storageKeys` that were issued to `userId`.
 *
 * Ownership is the query condition, so a key issued to someone else reads the
 * same as one never issued: absent.
 * @param userId - Who is asking.
 * @param storageKeys - The keys asked about.
 * @returns The caller's grants among them, in no particular order.
 */
export async function findOwnGrants(
  userId: string,
  storageKeys: readonly string[],
): Promise<UploadGrant[]> {
  if (storageKeys.length === 0) return [];
  const rows = await db
    .select()
    .from(uploadGrants)
    .where(
      and(eq(uploadGrants.userId, userId), inArray(uploadGrants.storageKey, [...storageKeys])),
    );
  return rows.map(toEntity);
}

/**
 * Mark a grant as died-without-an-asset: the upload was aborted, or what
 * arrived was refused. Single-shot like {@link consumeGrant} — a grant that
 * already reached either terminal state stays where it is, so a late abort
 * cannot undo a registration that succeeded.
 *
 * The object may well exist in storage at this point. Nothing here deletes it;
 * this row is what tells the operations-side cleanup that it has no owner.
 * @param storageKey - The key being written off.
 * @param reason - Why, as the upload status query will answer it.
 * @returns True when this call voided the grant; false when it was already
 *   consumed or already voided.
 */
export async function voidGrant(storageKey: string, reason: string): Promise<boolean> {
  const rows = await db
    .update(uploadGrants)
    .set({ voidedAt: sql`now()`, failureReason: reason })
    .where(
      and(
        eq(uploadGrants.storageKey, storageKey),
        isNull(uploadGrants.consumedAt),
        isNull(uploadGrants.voidedAt),
      ),
    )
    .returning({ id: uploadGrants.id });
  return rows.length > 0;
}
