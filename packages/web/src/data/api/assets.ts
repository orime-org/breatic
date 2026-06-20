// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet } from '@web/data/api/request';

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

export const assetsApi = {
  /**
   * Get a presigned upload URL for a direct browser → storage upload
   * (5-min expiry, 30/min rate limit, editor-or-above — all backend-enforced).
   * @param params - Upload metadata authorizing the presigned URL.
   * @param params.filename - Original file name (its extension picks the storage key suffix).
   * @param params.contentType - MIME type; the backend derives the asset `kind` from it.
   * @param params.projectId - Owning project (presign is gated on project edit access).
   * @returns The presigned upload URL, the resulting public URL, the storage key, and the kind.
   */
  presign(params: {
    filename: string;
    contentType: string;
    projectId: string;
  }): Promise<PresignResult> {
    return apiGet<PresignResult>('/assets/presign', {
      params: {
        filename: params.filename,
        content_type: params.contentType,
        project_id: params.projectId,
      },
    });
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
};
