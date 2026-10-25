// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Answering one browser upload with a ticket, a dedup hit or a refusal (#173,
 * inner#1303 §7).
 *
 * One upload and a batch of them run the same steps per file — the upload cap,
 * the dedup pass, the storage allowance, the grant and its task row, the signed
 * ticket. The storage allowance is asked through the caller, because a batch
 * asks it once for every file that needs room and a single upload throws its
 * refusal straight to the reader.
 */

import { AppError, env, getNodeTaskConfig, getStorageConfig, logger } from "@breatic/core";
import { assetService, safeExt, uploadDeadlineByKey, uploadTicketService } from "@breatic/domain";
import { TRANSFER_MEDIA_TYPE, type NodeTaskAction } from "@breatic/shared";

import * as assetUploadService from "@server/modules/asset/assetUpload.service.js";
import { INSUFFICIENT_STORAGE, assertStudioStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { openUpload } from "@server/modules/asset/upload-opening.js";

/** One file the browser wants to upload. */
export interface TicketItem {
  filename: string;
  content_type: string;
  size: number;
  client_hash: string;
  node_id?: string | undefined;
  space_id?: string | undefined;
  source?: "mini_tool" | undefined;
  tool_name?: string | undefined;
  derived?: boolean | undefined;
  purpose?: "project_cover" | "studio_avatar" | undefined;
}

/** The file name every transfer grant records. */
const TRANSFER_FILENAME = "body.transfer";

/**
 * The largest transfer file a ticket is signed for: the largest of the
 * per-route caps, since the ticket does not yet know which route it serves.
 * @returns The ceiling in bytes, signature line included.
 */
export function transferTicketMaxBytes(): number {
  return Math.max(...Object.values(getStorageConfig().transfer.route_max_bytes));
}

/** Where the file is going and who asked, already checked by the caller. */
export interface TicketScope {
  userId: string;
  studioId: string;
  /** Absent for a studio's own picture, which belongs to no project. */
  projectId?: string | undefined;
}

/** How one file is answered. */
export type TicketOutcome =
  | {
      kind: "ticket";
      ticket: string;
      storageKey: string;
      uploadUrl: string;
      assetKind: ReturnType<typeof assetService.detectAssetKind>;
      partSize: number;
      totalParts: number;
      taskId: string | undefined;
    }
  | {
      kind: "alreadyExists";
      assetId: string;
      fileUrl: string;
      assetKind: string;
      width: number | null;
      height: number | null;
    }
  | { kind: "refused"; reason: "too_large" | "storage" };

/** A file answered with a signed ticket. */
export type IssuedTicket = Extract<TicketOutcome, { kind: "ticket" }>;

/**
 * What an upload's task row says: a browser tool's export is shown as that
 * tool, every other upload by its file name.
 * @param item - The file.
 * @returns The row's action and label.
 */
function uploadRowOf(item: TicketItem): { action: NodeTaskAction; label: string } {
  return item.source === "mini_tool" && item.tool_name !== undefined
    ? { action: "mini_tool", label: item.tool_name }
    : { action: "upload", label: item.filename };
}

/**
 * Fail when the ingest Worker is not configured. Without the secret the
 * Worker would reject every ticket we sign; without the base URL the browser
 * has nowhere to send its parts. Neither is anything the user did, so this is
 * our own misconfiguration and reads as a 500.
 * @throws {Error} When either setting is missing.
 */
function assertIngestConfigured(): void {
  if (!env.INGEST_SHARED_SECRET || !env.INGEST_BASE_URL) {
    logger.error(
      { hasSecret: Boolean(env.INGEST_SHARED_SECRET), hasBaseUrl: Boolean(env.INGEST_BASE_URL) },
      "upload_ticket_ingest_unconfigured",
    );
    throw new Error("ingest Worker is not configured: INGEST_BASE_URL and INGEST_SHARED_SECRET are both required");
  }
}

/**
 * Answer a transfer file (inner#1006). It never becomes an asset and never
 * counts toward storage, so neither the dedup ledger nor the storage
 * allowance is asked; its grant has no node and no space, so no task row.
 * The size cap is the route schema's.
 * @param scope - Where it goes and who asked.
 * @param size - The whole transfer file's size, signature line included.
 * @returns The signed ticket.
 * @throws {Error} When the ingest Worker is not configured.
 */
export async function issueTransferTicket(scope: TicketScope, size: number): Promise<IssuedTicket> {
  const { userId, studioId, projectId } = scope;
  assertIngestConfigured();

  const expiresAt = Date.now() + getStorageConfig().ingest.ticket_expires_seconds * 1000;
  const { key, taskId } = await openUpload(
    {
      ...(projectId !== undefined ? { projectId } : { studioId }),
      actingUserId: userId,
      declaredSize: size,
      // `transfer/` is bound to the bucket's lifecycle rule and the public
      // domain's block on the prefix; changing it means changing both.
      taskType: "transfer",
      ext: ".transfer",
      expiresAt: new Date(expiresAt),
      context: {
        nodeId: null,
        spaceId: null,
        derived: true,
        filename: TRANSFER_FILENAME,
        assetSource: "transfer",
      },
    },
    { budgetMs: getNodeTaskConfig().default_budget_ms, action: "upload", label: TRANSFER_FILENAME },
  );
  const deadlineAt = await uploadDeadlineByKey(key);
  const target = await uploadTicketService.signTicketFor({
    storageKey: key,
    studioId,
    userId,
    declaredSize: size,
    contentType: TRANSFER_MEDIA_TYPE,
    expiresAt,
    deadlineAt,
  });
  logger.info({ key, userId, size }, "transfer_ticket_issued");

  return {
    kind: "ticket",
    ticket: target.ticket,
    storageKey: key,
    uploadUrl: target.uploadUrl,
    assetKind: assetService.detectAssetKind(TRANSFER_MEDIA_TYPE),
    partSize: target.partSize,
    totalParts: target.totalParts,
    taskId,
  };
}

/**
 * Answer one file: refuse it over the cap, settle it when the studio already
 * holds the content, refuse it when the caller's storage check says no, and
 * otherwise open its grant and row and sign its ticket.
 * @param scope - Where it goes and who asked.
 * @param item - The file.
 * @param admitStorage - Asked once this file needs room; false refuses it.
 * @returns The outcome.
 * @throws {Error} When the ingest Worker is not configured.
 */
export async function issueUploadTicket(
  scope: TicketScope,
  item: TicketItem,
  admitStorage: () => Promise<boolean>,
): Promise<TicketOutcome> {
  const { userId, studioId, projectId } = scope;
  const { upload, ingest } = getStorageConfig();
  if (item.size > upload.max_upload_bytes) {
    logger.info({ size: item.size, cap: upload.max_upload_bytes, userId }, "upload_ticket_rejected_over_cap");
    return { kind: "refused", reason: "too_large" };
  }

  // Dedup: the owner studio already holding this content skips the upload
  // entirely — no key, no grant, no ticket.
  const dedupHit = await assetUploadService.checkUploadDedup({ studioId, contentHash: item.client_hash });
  if (dedupHit) {
    logger.info({ hash: item.client_hash, userId, studioId, projectId }, "upload_ticket_dedup_hit");
    // No bytes move, but the node now shows something it did not show before:
    // a task row is opened and settled in the same pass, pointing at the
    // node's history row for this content (written now, or the one the node
    // already holds). The project activity feed gets nothing, because its only
    // shape for this is `asset:uploaded` and nothing was uploaded. A studio's
    // avatar has no project and no node, so there is nothing to settle.
    if (projectId !== undefined) {
      await assetUploadService.settleDedupHit({
        projectId,
        hit: dedupHit,
        userId,
        metadata: { filename: item.filename, size: item.size, mimeType: item.content_type },
        row: uploadRowOf(item),
        nodeId: item.node_id,
        spaceId: item.space_id,
      });
    }
    return {
      kind: "alreadyExists",
      assetId: dedupHit.assetId,
      fileUrl: dedupHit.fileUrl,
      assetKind: dedupHit.kind,
      width: dedupHit.width,
      height: dedupHit.height,
    };
  }

  // Storage gate, after the dedup return: that path consumes nothing.
  if (!(await admitStorage())) return { kind: "refused", reason: "storage" };

  // Both settings have to be present before a byte is authorised.
  assertIngestConfigured();

  const assetKind = assetService.detectAssetKind(item.content_type);
  // One rule for what may go in a key, shared with the lane that takes an
  // address. A separator or a query character spliced in makes publicUrl point
  // at a key R2 does not hold, and every read of that asset 404s.
  const ext = safeExt(item.filename);

  const expiresAt = Date.now() + ingest.ticket_expires_seconds * 1000;
  // The grant, and the task row this upload is on whatever node it lands on,
  // opened before the ticket that starts it (#186, design §4.6.5). Nothing
  // schedules a deadline: the row carries its own budget, and whoever opens
  // this node's task list is what judges it against the clock.
  const { key, taskId } = await openUpload(
    {
      ...(projectId !== undefined ? { projectId } : { studioId }),
      actingUserId: userId,
      declaredSize: item.size,
      taskType: assetKind,
      ext,
      expiresAt: new Date(expiresAt),
      context: {
        nodeId: item.node_id ?? null,
        spaceId: item.space_id ?? null,
        source: item.source ?? null,
        toolName: item.tool_name ?? null,
        // A cover is a byproduct: in the ledger, and not announced on the
        // project feed as something uploaded to the canvas.
        derived: item.purpose === "project_cover" ? true : (item.derived ?? null),
        filename: item.filename,
        assetSource: item.purpose ?? null,
      },
    },
    { budgetMs: getNodeTaskConfig().default_budget_ms, ...uploadRowOf(item) },
  );
  // The upload's two hours, read off the row or the grant just opened
  // (inner#1367). The ticket carries it; every session token the Worker
  // issues for this upload, and every call it makes for it, end there.
  const deadlineAt = await uploadDeadlineByKey(key);

  const target = await uploadTicketService.signTicketFor({
    storageKey: key,
    studioId,
    userId,
    declaredSize: item.size,
    contentType: item.content_type,
    expiresAt,
    deadlineAt,
  });
  logger.info({ key, kind: assetKind, totalParts: target.totalParts, userId }, "upload_ticket_issued");

  return {
    kind: "ticket",
    ticket: target.ticket,
    storageKey: key,
    uploadUrl: target.uploadUrl,
    assetKind,
    partSize: target.partSize,
    totalParts: target.totalParts,
    taskId,
  };
}

/** What every file of one batch shares: one browser tool's export, onto one Space. */
export interface TicketBatchContext {
  spaceId: string;
  toolName: string;
}

/**
 * Answer every file of one browser tool's export, in order. Files the studio
 * already holds settle as hits whatever its storage; the storage allowance is
 * asked once, at the first file that needs room, and refusing it refuses every
 * file that needs room.
 * @param scope - Where they go and who asked; `projectId` is required.
 * @param context - What they share.
 * @param items - The files, each on its own node.
 * @returns One outcome per file, in the order given.
 * @throws {AppError} Any storage refusal other than being full, and the errors {@link issueUploadTicket} throws.
 */
export async function issueUploadTicketBatch(
  scope: TicketScope & { projectId: string },
  context: TicketBatchContext,
  items: readonly TicketItem[],
): Promise<TicketOutcome[]> {
  let admitted: Promise<boolean> | undefined;
  /**
   * The studio's storage answer, asked once for the whole batch.
   * @returns Whether a file that needs room may have it.
   */
  const admit = (): Promise<boolean> =>
    (admitted ??= assertStudioStorageAllowance(scope.studioId, "upload").then(
      () => true,
      (err: unknown) => {
        if (err instanceof AppError && err.statusCode === INSUFFICIENT_STORAGE) return false;
        throw err;
      },
    ));
  const outcomes: TicketOutcome[] = [];
  for (const item of items) {
    outcomes.push(
      await issueUploadTicket(
        scope,
        { ...item, space_id: context.spaceId, source: "mini_tool", tool_name: context.toolName },
        admit,
      ),
    );
  }
  return outcomes;
}
