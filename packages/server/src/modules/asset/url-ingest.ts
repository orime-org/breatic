// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fetching an address somebody handed us into storage (task #207, inner#1351).
 *
 * The sibling of the browser's upload ticket, in the same order: access,
 * storage, then `openUpload` for the grant and, when a node is named, its
 * row, then hand off to the `url-ingest` queue. The address is fetched by the
 * ingest Worker, never by us.
 *
 * Two lanes start here. The canvas names the node the result goes to and
 * reads the outcome off that node's task list; the document body names no
 * node and reads the outcome from the upload status query under the key.
 */

import {
  createQueue,
  defaultJobOpts,
  getNodeTaskConfig,
  getStorageConfig,
  logger,
} from "@breatic/core";
import { extFromUrl, ingestReportService, labelForUrl } from "@breatic/domain";
import { INGEST_NOT_STARTED } from "@breatic/shared";

import { noteIngestSideEffects } from "@server/modules/asset/ingest-side-effects.js";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { openUpload, type OpenedUpload } from "@server/modules/asset/upload-opening.js";
import * as projectService from "@server/modules/project/project.service.js";

/** The queue the worker's `runUrlIngest` reads. */
const urlIngestQueue = createQueue("url-ingest");

/** One address to fetch, and where its result lands. */
export interface UrlIngestRequest {
  readonly url: string;
  readonly projectId: string;
  readonly spaceId: string;
  /** The node the result goes to; absent for a document body's block. */
  readonly nodeId?: string;
  readonly userId: string;
}

/**
 * Start a fetch whose result goes to a node.
 * @param request - The address, and the node it lands on.
 * @returns The storage key, the studio, and the node's row id.
 */
export async function startUrlIngest(
  request: UrlIngestRequest & { nodeId: string },
): Promise<OpenedUpload & { taskId: string }>;

/**
 * Start a fetch, with a node or without one.
 * @param request - The address and where it lands.
 * @returns The storage key, the studio, and the node's row id when a node was named.
 */
export async function startUrlIngest(request: UrlIngestRequest): Promise<OpenedUpload>;

/**
 * Check the caller may add to the project, open the upload and queue the
 * fetch.
 * @param request - The address and where it lands.
 * @returns The storage key, the studio, and the node's row id when a node was named.
 * @throws {AppError} 404 / 403 without access, 507 with no storage left.
 * @throws {Error} When the job cannot be queued; the upload is settled as not started first.
 */
export async function startUrlIngest(request: UrlIngestRequest): Promise<OpenedUpload> {
  const { url, projectId, spaceId, nodeId, userId } = request;
  await projectService.assertAccess(projectId, userId, "editor");
  await assertStorageAllowance(projectId, "upload");

  const { upload, ingest } = getStorageConfig();
  const opened = await openUpload(
    {
      projectId,
      actingUserId: userId,
      // The ceiling on what the Worker may write, since nothing here can say
      // how large the thing behind the address is (design §7.7).
      declaredSize: upload.max_upload_bytes,
      taskType: "url",
      ext: extFromUrl(url),
      expiresAt: new Date(Date.now() + ingest.ticket_expires_seconds * 1000),
      context: { ...(nodeId !== undefined && { nodeId }), spaceId, source: "url" },
    },
    {
      // Every task has the same two hours (inner#1367); the transfer is
      // held to the end of this row.
      budgetMs: getNodeTaskConfig().default_budget_ms,
      action: "upload",
      label: labelForUrl(url),
    },
  );

  try {
    await urlIngestQueue.add(
      "ingest-url",
      {
        storageKey: opened.key,
        studioId: opened.studioId,
        url,
        userId,
        projectId,
        spaceId,
        ...(nodeId !== undefined && { nodeId }),
      },
      // One delivery: a dead address stays dead, and the failure path voids
      // the grant, which a second run would walk straight past.
      { ...defaultJobOpts(), attempts: 1 },
    );
  } catch (err) {
    // A node's row is already on every open canvas, and a body's block is
    // asking the status query; either way the upload has to read as ended.
    logger.error({ err, key: opened.key, projectId }, "url_ingest_enqueue_failed");
    const settled = await ingestReportService.applyIngestReport({
      storageKey: opened.key,
      outcome: "aborted",
      reason: INGEST_NOT_STARTED,
    });
    // Settling can fail beside itself, and this is the one caller with no
    // second chance to notice: the request is about to throw.
    noteIngestSideEffects(opened.key, settled);
    throw err;
  }
  return opened;
}
