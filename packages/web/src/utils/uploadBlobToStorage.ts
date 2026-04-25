/**
 * Upload a Blob to permanent storage via the presigned-URL flow.
 *
 * Wraps `presign` + `uploadToPresignedUrl` so mini-tools that produce
 * a Blob client-side (Canvas output, ffmpeg.wasm output, etc.) can get
 * a stable fileUrl without touching the `/api/v1/assets/*` contract
 * directly.
 *
 * On success returns the permanent `fileUrl` that can be written to
 * the node's `content` field in Yjs.
 */

import { presign, uploadToPresignedUrl } from '@/apis/assets';

export interface UploadBlobContext {
  /** File name hint (extension kept by the backend for key generation). */
  filename: string;
  /** Project the upload belongs to — scopes the permanent key. */
  projectId: string;
}

/**
 * Upload `blob` and return the permanent URL.
 *
 * Throws if either the presign call or the PUT to cloud storage fails.
 * Callers are expected to wrap in try/catch and surface the error via
 * `failLocalPendingNode` + `message.error`.
 */
export async function uploadBlobToStorage(
  blob: Blob,
  ctx: UploadBlobContext,
): Promise<string> {
  const res = await presign({
    filename: ctx.filename,
    content_type: blob.type || 'application/octet-stream',
    project_id: ctx.projectId,
  });
  const data = res.data;
  if (!data) {
    throw new Error('presign returned empty payload');
  }
  await uploadToPresignedUrl(data.uploadUrl, blob);
  return data.fileUrl;
}
