/**
 * Assets API — presigned URL upload + history reporting.
 *
 * Upload flow:
 *   1. presign() → { uploadUrl, fileUrl, key, kind }
 *   2. PUT file to uploadUrl (direct to S3/OSS or local server)
 *   3. Write Yjs (canvas) or call agent attach API
 *   4. reportHistory() → record in node_history (async, best-effort)
 */

import { request, type CustomAxiosRequestConfig } from '@/data/api/request';
import type { ApiResponse } from '@breatic/shared';

/** Presign result — upload URL + permanent file URL. */
export interface PresignResult {
  uploadUrl: string;
  fileUrl: string;
  key: string;
  kind: 'image' | 'video' | 'audio' | 'document' | 'file';
}

/**
 * Get a presigned PUT URL for direct file upload.
 *
 * For cloud storage (S3/OSS): uploadUrl is a presigned PUT to cloud.
 * For local storage: uploadUrl is PUT /assets/local-upload/:key on
 * this server.
 */
export const presign = (
  params: { filename: string; content_type: string; project_id: string },
  needGlobalLoading = false,
) =>
  request<ApiResponse<PresignResult>>({
    url: '/api/v1/assets/presign',
    method: 'get',
    params,
    needGlobalLoading,
  } as CustomAxiosRequestConfig);

/**
 * Upload a file to the presigned URL.
 *
 * Uses fetch (not axios) for raw binary PUT with correct
 * Content-Type header.
 */
export async function uploadToPresignedUrl(
  uploadUrl: string,
  file: File | Blob,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
  });
  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * Report a file upload to node_history (async, best-effort).
 *
 * Call AFTER writing to Yjs. Failure does not affect the upload.
 */
export const reportHistory = (data: {
  type: 'upload';
  project_id: string;
  node_id: string;
  content: string;
  thumbnail_url?: string;
  metadata: { filename: string; size: number; mimeType: string };
}) =>
  request<ApiResponse<{ ok: true }>>({
    url: '/api/v1/assets/history',
    method: 'post',
    data,
  });
