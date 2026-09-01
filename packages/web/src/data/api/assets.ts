// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { apiGet, apiPost } from '@web/data/api/request';
import type { UploadClientConfig } from '@web/data/upload/upload-retry';
import type { UploadTicketResponse } from '@web/data/upload/ingest-upload';

/** Session cache for the upload knobs (one fetch per session). */
let uploadConfigCache: UploadClientConfig | null = null;

export const assetsApi = {
  /**
   * Ask for permission to upload (#173, design §4.1).
   *
   * The answer is either a signed ticket to carry to the ingest Worker, or
   * word that this studio already holds the content — in which case nothing
   * moves and the server has already told the node what it now holds.
   *
   * The context travels here rather than with the bytes: the Worker knows only
   * what the ticket tells it and cannot be asked to prove any of it, so what
   * the browser declares is checked against this user's access now and stored
   * on the grant the report reads back.
   * @param params - What is being uploaded and where it lands.
   * @param params.filename - The picked file's name; its extension picks the key's suffix.
   * @param params.contentType - MIME type; the server derives the asset kind from it.
   * @param params.projectId - Owning project, which gates the request.
   * @param params.size - Declared byte size, the authoritative cap gate input.
   * @param params.hash - Content sha256. Mandatory: an upload that cannot be
   *   fingerprinted is refused before it gets here, and the server rejects a
   *   request without one.
   * @param params.leaseGen - The node's fencing gen at the moment handling
   *   opened, which the event announcing the outcome carries back.
   * @param params.nodeId - The node the bytes land on, when there is one.
   * @param params.spaceId - The space that node lives in.
   * @param params.source - `mini_tool` for a mini-tool product.
   * @param params.toolName - The mini-tool's name when `source` says so.
   * @param params.derived - True for a byproduct, which is registered without
   *   an activity-feed row of its own.
   * @returns The ticket to upload with, or the existing asset to reuse.
   */
  requestUploadTicket(params: {
    filename: string;
    contentType: string;
    projectId: string;
    size: number;
    hash: string;
    leaseGen: number;
    nodeId?: string;
    spaceId?: string;
    source?: 'mini_tool';
    toolName?: string;
    derived?: true;
  }): Promise<UploadTicketResponse> {
    return apiPost<UploadTicketResponse>('/assets/upload-ticket', {
      filename: params.filename,
      content_type: params.contentType,
      project_id: params.projectId,
      size: params.size,
      client_hash: params.hash,
      lease_gen: params.leaseGen,
      ...(params.nodeId !== undefined && { node_id: params.nodeId }),
      ...(params.spaceId !== undefined && { space_id: params.spaceId }),
      ...(params.source !== undefined && { source: params.source }),
      ...(params.toolName !== undefined && { tool_name: params.toolName }),
      ...(params.derived !== undefined && { derived: params.derived }),
    });
  },

  /**
   * The browser upload knobs (`config/storage.yaml` `upload:` section),
   * fetched once per session and cached. A failed fetch is NOT cached —
   * the next caller retries.
   * @returns The upload knobs (cap, attempts, backoff, timeouts).
   */
  async fetchUploadConfig(): Promise<UploadClientConfig> {
    if (uploadConfigCache) return uploadConfigCache;
    const cfg = await apiGet<UploadClientConfig>('/assets/upload-config');
    uploadConfigCache = cfg;
    return cfg;
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
