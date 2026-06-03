// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet, request } from '@web/data/api/request';

export interface PresignedUpload {
  url: string;
  publicUrl: string;
  expiresAt: string;
}

export const assetsApi = {
  /**
   * Get a presigned URL for direct browser → storage upload.
   * 5-min expiry, 30/min rate limit (backend-enforced).
   * @param params - Upload metadata used to authorize the presigned URL.
   * @param params.contentType - MIME type of the file to be uploaded.
   * @param params.size - File size in bytes, validated against backend limits.
   * @returns Presigned upload URL, the resulting public URL, and the expiry timestamp.
   */
  presign(params: { contentType: string; size: number }): Promise<PresignedUpload> {
    return apiGet<PresignedUpload>('/assets/presign', { params });
  },

  /**
   * Local-mode upload (dev / docker / when storage = local).
   * In production we PUT to the presigned URL directly.
   * @param key - Storage object key the file is uploaded under.
   * @param file - The browser `File` to upload.
   */
  async localUpload(key: string, file: File): Promise<void> {
    await request.put(`/assets/local-upload/${key}`, file, {
      headers: { 'Content-Type': file.type },
    });
  },
};
