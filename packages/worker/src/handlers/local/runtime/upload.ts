/**
 * Upload a local temp file to permanent storage and return the public URL.
 *
 * Thin wrapper over `@breatic/core`'s `getStorageAdapter().upload()`
 * that handles the file → Buffer read + key generation so local
 * handlers don't have to touch the storage adapter or `fs` directly.
 *
 * Handlers call this at the end of their pipeline:
 *   `const url = await uploadTempFileToStorage({ path, userId, projectId, taskType, ext, contentType });`
 * and return the returned URL on the result — which `runMiniTool`
 * then forwards unchanged (`persistResultUrls` on permanent URLs is
 * a no-op).
 */

import { readFile } from "node:fs/promises";
import { getStorageAdapter, storageKey } from "@breatic/core";

export interface UploadTempFileOptions {
  /** Absolute path of the local temp file (inside the job temp dir). */
  path: string;
  /** Storage key owner — permanent URL is scoped to this user. */
  userId: string;
  /** Project ID for key prefix (defaults to "default" inside `storageKey`). */
  projectId?: string;
  /**
   * Task type for key prefix ("image", "video", "audio", …). Matches
   * the Worker job's `taskType`.
   */
  taskType: string;
  /** File extension with leading dot (e.g. `".mp4"`, `".png"`). */
  ext: string;
  /** MIME type for the stored object (e.g. `"video/mp4"`). */
  contentType: string;
}

/**
 * Read a local temp file and upload it to permanent storage. Returns
 * the public URL suitable for writing to a Yjs node's `content`.
 *
 * @throws `Error` if the file cannot be read or the adapter upload fails
 */
export async function uploadTempFileToStorage(
  opts: UploadTempFileOptions,
): Promise<string> {
  const buffer = await readFile(opts.path);
  const key = storageKey({
    userId: opts.userId,
    projectId: opts.projectId,
    taskType: opts.taskType,
    ext: opts.ext,
  });
  const adapter = await getStorageAdapter();
  return await adapter.upload(key, buffer, opts.contentType);
}
