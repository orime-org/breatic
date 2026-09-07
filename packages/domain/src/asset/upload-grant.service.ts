// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Minting the key an upload lands on, and the ledger row it is checked against
 * (#1826, design §2.2).
 *
 * This is the one door onto `upload_grants` for anyone opening an upload:
 * whether the bytes come from a browser asking for a ticket or from the worker
 * holding a buffer it just produced, the same three steps happen — resolve the
 * owner studio from the project, mint a tenant-neutral key, write the grant.
 * Ownership is decided here, while the caller's access to the project is known,
 * rather than being asked of the ingest Worker's report, which knows only what
 * the ticket told it.
 *
 * The caps around it are not here. The upload size cap and the studio's storage
 * allowance are checked at each entrance (`routes/assets.ts` for the browser,
 * `routes/canvas.ts` for a generation) because what counts as too big and who
 * pays for it are things the entrance knows and this does not.
 */

import { storageKey } from "@breatic/core";
import { resolveOwnerStudioId } from "@domain/asset/asset.service.js";
import { issueGrant } from "@domain/asset/upload-grant.repo.js";

/**
 * Mint a tenant-neutral storage key for an upload and record its grant.
 *
 * The browser's ticket endpoint calls this only after the dedup check misses
 * (a hit uploads nothing, so it needs no key and no grant); the worker calls it
 * for every upload it opens, having no dedup pre-check of its own — its hash
 * does not exist until the edge computes it.
 * @param params - The upload claim + key components.
 * @param params.projectId - Project the upload targets; it alone decides the
 *   owner studio (#1839 — never the acting user's own).
 * @param params.actingUserId - Who this upload is attributed to.
 * @param params.declaredSize - Byte size as declared (UX pre-check only).
 * @param params.taskType - The detected kind, used as the key's task segment.
 * @param params.ext - The dotted file extension for the key.
 * @param params.expiresAt - When the grant stops being usable.
 * @param params.context - Node, space, and provenance for the report to use.
 * @param params.context.nodeId - Node the bytes land on, when there is one.
 * @param params.context.spaceId - Canvas space holding that node.
 * @param params.context.source - What started this upload.
 * @param params.context.toolName - Mini-tool that produced the bytes, if any.
 * @param params.context.derived - True when the bytes came out of another asset.
 * @param params.context.filename - Original file name, shown in history.
 * @returns The minted storage key K and the owner studio it was attributed to.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 */
export async function issueUploadGrant(params: {
  projectId: string;
  actingUserId: string;
  declaredSize: number;
  taskType: string;
  ext: string;
  expiresAt: Date;
  context: {
    nodeId?: string | null;
    spaceId?: string | null;
    source?: string | null;
    toolName?: string | null;
    derived?: boolean | null;
    filename?: string | null;
  };
}): Promise<{ key: string; studioId: string }> {
  const studioId = await resolveOwnerStudioId(params.projectId);
  const key = storageKey({ taskType: params.taskType, ext: params.ext });
  await issueGrant({
    userId: params.actingUserId,
    studioId,
    storageKey: key,
    declaredSize: params.declaredSize,
    expiresAt: params.expiresAt,
    context: { ...params.context, projectId: params.projectId },
  });
  return { key, studioId };
}
