/**
 * Storage adapter — unified interface for file persistence.
 *
 * Three providers:
 * - local: filesystem (default, downloads file to disk)
 * - s3: AWS S3 / MinIO / R2 (uploads buffer to S3)
 * - aliyun_oss: Alibaba Cloud OSS (uploads buffer to OSS)
 */

import { randomUUID } from "node:crypto";
import { env } from "@core/config/env.js";

/** Metadata returned by StorageAdapter.head() after a client upload. */
export interface ObjectHead {
  size: number;
  contentType: string;
  exists: boolean;
}

/** Storage adapter interface. */
export interface StorageAdapter {
  /** Upload binary data and return a public URL. */
  upload(key: string, data: Buffer, contentType: string): Promise<string>;

  /**
   * Persist a file from a remote URL and return a permanent URL.
   *
   * - local: downloads to disk, serves via static route
   * - s3/oss: downloads then uploads to cloud storage
   */
  persistFromUrl(sourceUrl: string, key: string): Promise<string>;

  /**
   * Generate a presigned PUT URL for client-side direct upload.
   *
   * Not supported by local storage — throws if called.
   *
   * @param key - Storage key where the client will PUT the file
   * @param contentType - Expected MIME type
   * @param expiresSeconds - URL lifetime in seconds
   */
  getUploadUrl?(
    key: string,
    contentType: string,
    expiresSeconds: number,
  ): Promise<string>;

  /**
   * Inspect an object by key — used to verify an upload completed.
   *
   * @returns `{ size, contentType, exists }`. If the object does not
   *          exist, `exists` is `false` and other fields are zero/empty.
   */
  head(key: string): Promise<ObjectHead>;

  /**
   * Build the public URL for a storage key without fetching.
   * Used after a client direct upload to construct the asset URL.
   */
  publicUrl(key: string): string;
}

// Singleton
let _adapter: StorageAdapter | null = null;

/** Get the configured storage adapter singleton. */
export async function getStorageAdapter(): Promise<StorageAdapter> {
  if (_adapter) return _adapter;

  switch (env.STORAGE_PROVIDER) {
    case "local": {
      const { LocalStorageAdapter } = await import("@core/infra/storage/local.js");
      _adapter = new LocalStorageAdapter();
      break;
    }
    case "s3": {
      const { S3StorageAdapter } = await import("@core/infra/storage/s3.js");
      _adapter = new S3StorageAdapter();
      break;
    }
    case "aliyun_oss": {
      const { AliyunOSSStorageAdapter } = await import("@core/infra/storage/oss.js");
      _adapter = new AliyunOSSStorageAdapter();
      break;
    }
  }

  return _adapter!;
}

/**
 * Generate a unique storage key.
 *
 * Format (with user): {userId}/{projectId}/{taskType}/{date}/{unixtime}_{uuid}{ext}
 * Format (without user): {taskType}/{date}/{unixtime}_{uuid}{ext}
 *
 * @param opts.userId - User ID (optional — omit for transport-level uploads)
 * @param opts.projectId - Project ID (defaults to "default")
 * @param opts.taskType - Task type (image, video, audio, tts, etc.)
 * @param opts.ext - File extension (e.g. ".png", ".mp4")
 */
export function storageKey(opts: {
  userId?: string;
  projectId?: string;
  taskType: string;
  ext: string;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${Date.now()}_${randomUUID()}${opts.ext}`;
  if (opts.userId) {
    const project = opts.projectId || "default";
    return `${opts.userId}/${project}/${opts.taskType}/${date}/${filename}`;
  }
  return `${opts.taskType}/${date}/${filename}`;
}

/**
 * Download from temporary URL and persist to storage.
 * Delegates to adapter's persistFromUrl().
 */
export async function downloadAndStore(url: string, key: string): Promise<string> {
  const adapter = await getStorageAdapter();
  return adapter.persistFromUrl(url, key);
}
