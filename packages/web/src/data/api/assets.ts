// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { apiGet, apiPost } from '@web/data/api/request';
import type { UploadClientConfig } from '@breatic/shared';
import type {
  BatchTicketAnswer,
  BatchTicketRequest,
  UploadTicketRequest,
  UploadTicketResponse,
} from '@web/data/upload/ingest-upload';

/** The upload knobs, and what every address of ours starts with. */
export interface UploadConfig extends UploadClientConfig {
  /** What every stored object's public URL starts with. */
  assetUrlPrefix: string;
  /**
   * The largest request body the API reads, in bytes (inner#1006). Absent
   * from a server that predates it, so it is read as unknown until checked.
   */
  maxRequestBodyBytes?: unknown;
}

/**
 * The request body limit these knobs name, when it is usable.
 * @param cfg - The upload knobs, or null when the page has none.
 * @returns The limit in bytes; null when absent or not a positive integer
 *   (a server that predates it sends none).
 */
export function requestBodyLimitOf(cfg: UploadConfig | null): number | null {
  const limit = cfg?.maxRequestBodyBytes;
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null;
}

/**
 * The server opens the upload at the ingest Worker before it answers a ticket
 * request, bounded by the task budget (inner#1595), so the page waits for that
 * answer: giving up at the client timeout and asking again would open a second
 * grant and task row.
 */
export const NO_CLIENT_TIMEOUT = { timeout: 0 } as const;

/** Session cache for the upload knobs (one fetch per session). */
let uploadConfigCache: UploadConfig | null = null;

export const assetsApi = {
  /**
   * Ask for permission to upload (#173, design §4.1).
   *
   * The answer is an upload our server already opened at the ingest Worker,
   * word that this studio already holds the content — in which case nothing
   * moves and the server has already told the node what it now holds — or
   * word that the server could not open the upload (inner#1595).
   *
   * The context travels here rather than with the bytes: the Worker knows only
   * what the ticket tells it and cannot be asked to prove any of it, so what
   * the browser declares is checked against this user's access now and stored
   * on the grant the report reads back.
   * @param params - What is being uploaded and where it lands.
   * @param params.filename - The picked file's name; its extension picks the key's suffix.
   * @param params.contentType - MIME type; the server derives the asset kind from it.
   * @param params.projectId - Owning project, which gates the request. Absent
   *   for a studio's avatar, which names the studio instead.
   * @param params.studioId - The studio, for a studio's avatar.
   * @param params.size - Declared byte size, the authoritative cap gate input.
   * @param params.hash - Content sha256. Mandatory: an upload that cannot be
   *   fingerprinted is refused before it gets here, and the server rejects a
   *   request without one.
   * @param params.nodeId - The node the bytes land on, when there is one.
   * @param params.spaceId - The space that node lives in.
   * @param params.source - `mini_tool` for a mini-tool product.
   * @param params.toolName - The mini-tool's name when `source` says so.
   * @param params.derived - True for a byproduct, which is registered without
   *   an activity-feed row of its own.
   * @param params.focusImage - For a focus crop, the image it becomes and the node whose pool takes it.
   * @param params.purpose - Upload use context; models retain the ordinary upload source.
   * @param params.label - The name a 3D model is imported under.
   * @param params.objectId - The 3D object a part picture is for.
   * @param params.part - That object's part.
   * @param params.startMap - The part's picture when the upload started, or null for none.
   * @param signal - Cancellation belonging to this authorization request.
   * @returns The opened upload, the existing asset to reuse, or the open
   *   that failed.
   * @throws {ApiException} When the request fails.
   */
  requestUploadTicket(params: UploadTicketRequest, signal?: AbortSignal): Promise<UploadTicketResponse> {
    return apiPost<UploadTicketResponse>('/assets/upload-ticket', {
      filename: params.filename,
      content_type: params.contentType,
      ...(params.projectId !== undefined && { project_id: params.projectId }),
      ...(params.studioId !== undefined && { studio_id: params.studioId }),
      size: params.size,
      client_hash: params.hash,
      ...(params.nodeId !== undefined && { node_id: params.nodeId }),
      ...(params.spaceId !== undefined && { space_id: params.spaceId }),
      ...(params.uploadId !== undefined && { upload_id: params.uploadId }),
      ...(params.uploadTarget !== undefined && { upload_target: params.uploadTarget }),
      ...(params.source !== undefined && { source: params.source }),
      ...(params.toolName !== undefined && { tool_name: params.toolName }),
      ...(params.derived !== undefined && { derived: params.derived }),
      ...(params.focusImage !== undefined && { focusImage: params.focusImage }),
      ...(params.purpose !== undefined && { purpose: params.purpose }),
      ...(params.label !== undefined && { label: params.label }),
      ...(params.objectId !== undefined && { object_id: params.objectId }),
      ...(params.part !== undefined && { part: params.part }),
      ...(params.startMap !== undefined && { start_map: params.startMap }),
    }, { ...NO_CLIENT_TIMEOUT, ...(signal !== undefined && { signal }) });
  },

  /**
   * Tell the server a focus crop's bytes never reached the edge (#1580), as a node's upload reports its row, so the
   * crop stops showing as uploading in its node.
   * @param storageKey - The key the crop's grant was opened on.
   * @returns Nothing, once the server ended it.
   * @throws {ApiException} When the request fails.
   */
  async reportFocusUploadFailure(storageKey: string): Promise<void> {
    await apiPost('/assets/focus-uploads/failure', { storageKey, reason: 'aborted' });
  },

  /**
   * Ask for every ticket of one browser tool's export in one request
   * (inner#1303 §7).
   * @param params - Where the files land, the tool, and each file on its node.
   * @returns One answer per file, in order: an opened upload, an existing
   *   asset to reuse, an open that failed, or a refusal.
   * @throws {ApiException} When the request fails.
   */
  async requestUploadTicketBatch(params: BatchTicketRequest): Promise<BatchTicketAnswer[]> {
    const { items } = await apiPost<{ items: BatchTicketAnswer[] }>('/assets/upload-ticket', {
      project_id: params.projectId,
      space_id: params.spaceId,
      source: params.source,
      tool_name: params.toolName,
      items: params.items.map((item) => ({
        filename: item.filename,
        content_type: item.contentType,
        size: item.size,
        client_hash: item.hash,
        node_id: item.nodeId,
      })),
    }, NO_CLIENT_TIMEOUT);
    return items;
  },

  /**
   * Have the ingest Worker fetch an address into a Document body block
   * (inner#1351 + inner#1390 design §4.1). The server announces how it ends
   * to the block and collab writes it (breatic#1574).
   * @param body - The address and where it lands.
   * @param body.url - The `https:` address.
   * @param body.project_id - The project it lands in.
   * @param body.space_id - The Space it lands in.
   * @param body.upload_id - The Document body block the result is written into (breatic#1574).
   * @returns The storage key its finish is queued under.
   * @throws {import('@web/data/api/types').ApiException} On 400 / 403 / 429 / 507, or 500 when the fetch could not be queued.
   */
  ingestUrl(body: { url: string; project_id: string; space_id: string; upload_id: string }): Promise<{ storage_key: string }> {
    return apiPost<{ storage_key: string }>('/assets/ingest-url', body);
  },

  /**
   * The browser upload knobs (`config/storage.yaml` `upload:` section),
   * fetched once per session and cached. A failed fetch is NOT cached —
   * the next caller retries.
   * @returns The upload knobs (cap, attempts, backoff, the idle window).
   */
  async fetchUploadConfig(): Promise<UploadConfig> {
    if (uploadConfigCache) return uploadConfigCache;
    const cfg = await apiGet<UploadConfig>('/assets/upload-config');
    uploadConfigCache = cfg;
    return cfg;
  },

  /**
   * The upload knobs if this session has fetched them, read at once.
   *
   * For a reader that cannot wait: a paste is judged synchronously
   * (inner#1127 A18), and the body fetches the knobs when it opens.
   * @returns The cached knobs, or null before the first fetch lands.
   */
  cachedUploadConfig(): UploadConfig | null {
    return uploadConfigCache;
  },

  /**
   * Drop the session cache (tests only).
   */
  resetUploadConfigCache(): void {
    uploadConfigCache = null;
  },

  /**
   * Report deleted assets (activity feed, batch). Report-only — the
   * deletion itself is a client-side Yjs operation.
   * @param params - Project + the deleted asset entries.
   * @param params.projectId - Owning project.
   * @param params.entries - One entry per deleted asset-bearing node.
   * @returns Nothing (the activity rows are server-side).
   */
  async reportDeleted(params: {
    projectId: string;
    entries: Array<{
      fileUrl: string;
      kind: string;
      nodeId?: string;
      spaceId?: string;
    }>;
  }): Promise<void> {
    // The server caps a batch at 100 entries (routes/assets.ts .max(100)) —
    // chunk here so a mass-delete of crop-heavy nodes (pool cap 50/node)
    // never 400s the whole audit batch (adversarial round-4).
    const BATCH = 100;
    for (let i = 0; i < params.entries.length; i += BATCH) {
      await apiPost<{ ok: boolean }>('/assets/deleted', {
        project_id: params.projectId,
        entries: params.entries.slice(i, i + BATCH).map((e) => ({
          file_url: e.fileUrl,
          kind: e.kind,
          ...(e.nodeId !== undefined && { node_id: e.nodeId }),
          ...(e.spaceId !== undefined && { space_id: e.spaceId }),
        })),
      });
    }
  },
};
