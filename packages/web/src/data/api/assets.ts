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
   */
  presign(params: { contentType: string; size: number }) {
    return apiGet<PresignedUpload>('/assets/presign', { params });
  },

  /**
   * Local-mode upload (dev / docker / when storage = local).
   * In production we PUT to the presigned URL directly.
   */
  async localUpload(key: string, file: File): Promise<void> {
    await request.put(`/assets/local-upload/${key}`, file, {
      headers: { 'Content-Type': file.type },
    });
  },
};
