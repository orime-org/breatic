// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { apiGet, apiPost, request } from '@web/data/api/request';
import type { ApiEnvelope } from '@web/data/api/types';
import type { UploadClientConfig, UploadStatus } from '@breatic/shared';
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
   * How long the page waits before asking how its uploads ended, in seconds,
   * until an answer names its own interval (inner#1367).
   */
  uploadStatusPollSeconds: number;
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

/** Session cache for the upload knobs (one fetch per session). */
let uploadConfigCache: UploadConfig | null = null;

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
   * @param params.purpose - What the picture is uploaded to become, filed as
   *   the asset's source; a studio uploads only its avatar.
   * @returns The ticket to upload with, or the existing asset to reuse.
   */
  requestUploadTicket(params: UploadTicketRequest): Promise<UploadTicketResponse> {
    return apiPost<UploadTicketResponse>('/assets/upload-ticket', {
      filename: params.filename,
      content_type: params.contentType,
      ...(params.projectId !== undefined && { project_id: params.projectId }),
      ...(params.studioId !== undefined && { studio_id: params.studioId }),
      size: params.size,
      client_hash: params.hash,
      ...(params.nodeId !== undefined && { node_id: params.nodeId }),
      ...(params.spaceId !== undefined && { space_id: params.spaceId }),
      ...(params.source !== undefined && { source: params.source }),
      ...(params.toolName !== undefined && { tool_name: params.toolName }),
      ...(params.derived !== undefined && { derived: params.derived }),
      ...(params.purpose !== undefined && { purpose: params.purpose }),
    });
  },

  /**
   * Ask for every ticket of one browser tool's export in one request
   * (inner#1303 §7).
   * @param params - Where the files land, the tool, and each file on its node.
   * @returns One answer per file, in order: a ticket, an existing asset to
   *   reuse, or a refusal.
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
    });
    return items;
  },

  /**
   * Ask how these uploads ended (inner#1367 §4.2a).
   * @param keys - The keys their finishes were queued under, at most
   *   `UPLOAD_STATUS_MAX_KEYS`.
   * @returns One status per key, and how long the server asks to be left
   *   before the next question, when it said. Rate-limited, no status and the
   *   wait the server named.
   * @throws {ApiException} When the request fails.
   */
  async fetchUploadStatus(
    keys: readonly string[],
  ): Promise<{ items: UploadStatus[]; retryAfterSeconds: number | null }> {
    const res = await request.get<ApiEnvelope<{ items: UploadStatus[] }>>(
      '/assets/upload-status',
      {
        // `key=a&key=b`, the repeated form the route reads.
        params: { key: [...keys] },
        paramsSerializer: { indexes: null },
        // A 429 says when to ask again, in its Retry-After header only; the
        // limiter counts every request, refused ones too, so asking sooner
        // keeps the page refused.
        validateStatus: (status) => (status >= 200 && status < 300) || status === 429,
      },
    );
    const seconds = Number(res.headers['retry-after']);
    return {
      items: res.status === 429 ? [] : res.data.data.items,
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    };
  },

  /**
   * The browser upload knobs (`config/storage.yaml` `upload:` section),
   * fetched once per session and cached. A failed fetch is NOT cached —
   * the next caller retries.
   * @returns The upload knobs (cap, attempts, backoff, the idle window, the
   *   status poll interval).
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
