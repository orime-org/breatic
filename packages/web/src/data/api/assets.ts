// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet, apiPost } from '@web/data/api/request';
import type { UploadClientConfig } from '@web/data/upload/upload-retry';

/** Result of a presign request — matches the backend `/assets/presign` shape. */
export interface PresignResult {
  /** Where the client PUTs the file (presigned S3/OSS URL, or the local endpoint). */
  uploadUrl: string;
  /** The permanent public URL the asset is served from after upload. */
  fileUrl: string;
  /** Storage object key. */
  key: string;
  /** Detected asset kind: `image` / `video` / `audio` / `document` / `file`. */
  kind: string;
}

/**
 * A presign dedup hit (#1609, B.2): the studio already holds this
 * content — nothing to upload, the node reuses the existing URL.
 */
export interface PresignDedupHit {
  alreadyExists: true;
  /** The existing asset's public URL (same studio + same content = same URL). */
  fileUrl: string;
  /** The existing asset's kind. */
  kind: string;
}

/** Either branch a presign can answer with. */
export type PresignResponse = PresignResult | PresignDedupHit;

/**
 * Discriminate a presign response: dedup hit vs normal presign.
 * @param res - The presign response.
 * @returns True when the response is an instant-dedup hit.
 */
export function isDedupHit(res: PresignResponse): res is PresignDedupHit {
  return 'alreadyExists' in res && res.alreadyExists;
}

/** Session cache for the upload knobs (one fetch per session). */
let uploadConfigCache: UploadClientConfig | null = null;

export const assetsApi = {
  /**
   * Get a presigned upload URL for a direct browser → storage upload
   * (5-min expiry, 30/min rate limit, editor-or-above — all backend-enforced).
   * @param params - Upload metadata authorizing the presigned URL.
   * @param params.filename - Original file name (its extension picks the storage key suffix).
   * @param params.contentType - MIME type; the backend derives the asset `kind` from it.
   * @param params.projectId - Owning project (presign is gated on project edit access).
   * @param params.size - Declared byte size (authoritative cap gate + dedup size distrust).
   * @param params.hash - Content sha256, or null when hashing degraded (omitted from the wire).
   * @returns A normal presign (uploadUrl/fileUrl/key/kind) or a dedup hit (alreadyExists/fileUrl/kind).
   */
  presign(params: {
    filename: string;
    contentType: string;
    projectId: string;
    /** Declared byte size (authoritative cap gate + dedup size distrust). */
    size: number;
    /** Content sha256, or null when hashing degraded (worker failure). */
    hash?: string | null;
  }): Promise<PresignResponse> {
    return apiGet<PresignResponse>('/assets/presign', {
      params: {
        filename: params.filename,
        content_type: params.contentType,
        project_id: params.projectId,
        size: params.size,
        ...(params.hash != null && { hash: params.hash }),
      },
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
   * PUT a file to its presigned upload URL. Works for both cloud storage
   * (S3/OSS presigned URL — cross-origin, signature in the URL, no cookie) and
   * local mode (same-origin app endpoint — cookie auth): `credentials:
   * 'same-origin'` attaches the session cookie only to our own origin and
   * never leaks it to cloud storage.
   * @param uploadUrl - The presigned `uploadUrl` from {@link presign}.
   * @param file - The browser `File` to upload.
   * @throws {Error} When the storage responds with a non-2xx status.
   */
  async putFile(uploadUrl: string, file: File): Promise<void> {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
      credentials: 'same-origin',
    });
    if (!res.ok) {
      throw new Error(`Asset upload failed (HTTP ${res.status})`);
    }
  },

  /**
   * Report a completed upload (activity-feed handshake, ADR 2026-07-04).
   * The server verifies the object exists in storage (head()) before the
   * activity row is recorded — call AFTER the PUT succeeded.
   * @param params - Upload identity + optional canvas context.
   * @param params.projectId - Owning project.
   * @param params.key - Storage key returned by {@link presign} (regular path).
   * @param params.kind - Asset kind returned by {@link presign}.
   * @param params.hash - Content sha256 (ledger registration / dedup lookup).
   * @param params.dedup - True for a dedup report (presign said `alreadyExists`).
   * @param params.nodeId - Canvas node the asset landed on, when node-bound.
   * @param params.spaceId - Space the node lives in.
   * @param params.source - `mini_tool` for frontend-executed mini-tool products.
   * @param params.toolName - Mini-tool name when `source` is set.
   * @param params.metadata - Original-file facts for the node-history record.
   * @param params.metadata.filename - Original file name.
   * @param params.metadata.size - Original byte size (client-declared).
   * @param params.metadata.mimeType - Original MIME type.
   * @returns Nothing (the activity row is server-side).
   */
  async reportUploaded(params: {
    projectId: string;
    /** Storage key (regular path); absent on a dedup report. */
    key?: string;
    kind: string;
    /** Content sha256 → ledger registration (regular) / lookup (dedup). */
    hash?: string;
    /** True when the presign answered `alreadyExists` (nothing uploaded). */
    dedup?: true;
    nodeId?: string;
    spaceId?: string;
    source?: 'mini_tool';
    toolName?: string;
    /** Original-file facts for the node-history record. */
    metadata?: { filename: string; size: number; mimeType: string };
  }): Promise<void> {
    await apiPost<{ ok: boolean }>('/assets/uploaded', {
      project_id: params.projectId,
      kind: params.kind,
      ...(params.key !== undefined && { key: params.key }),
      ...(params.hash !== undefined && { hash: params.hash }),
      ...(params.dedup !== undefined && { dedup: params.dedup }),
      ...(params.nodeId !== undefined && { node_id: params.nodeId }),
      ...(params.spaceId !== undefined && { space_id: params.spaceId }),
      ...(params.source !== undefined && { source: params.source }),
      ...(params.toolName !== undefined && { tool_name: params.toolName }),
      ...(params.metadata !== undefined && { metadata: params.metadata }),
    });
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
