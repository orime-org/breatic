// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storage upload helpers for local worker handlers.
 *
 * Two forms:
 *   - `uploadTempFileToStorage({ path, ... })` for CLI-based handlers
 *     (FFmpeg, ImageMagick) that land their output on disk.
 *   - `uploadBufferToStorage({ buffer, ... })` for in-process library
 *     handlers (Sharp, etc.) that hold the output as a Buffer and want
 *     to skip the tempfile roundtrip.
 *
 * Both funnel into the same `getStorageAdapter().upload()` call so
 * adapter wiring stays in one place.
 */

import { readFile } from "node:fs/promises";
import { getStorageAdapter, storageKey } from "@breatic/core";

interface UploadCommonOptions {
  /**
   * Task type segment of the (tenant-neutral) storage key ("image",
   * "video", "audio", …). Matches the Worker job's `taskType`.
   */
  taskType: string;
  /** File extension with leading dot (e.g. `".mp4"`, `".png"`). */
  ext: string;
  /** MIME type for the stored object (e.g. `"video/mp4"`). */
  contentType: string;
}

export type UploadTempFileOptions = UploadCommonOptions & {
  /** Absolute path of the local temp file (inside the job temp dir). */
  path: string;
};

export type UploadBufferOptions = UploadCommonOptions & {
  /** In-memory output Buffer (for Node-library handlers like Sharp). */
  buffer: Buffer;
};

/**
 * Build the (tenant-neutral) storage key shared by both upload forms.
 * @param opts - Common upload options (task type / extension)
 * @returns A tenant-neutral storage key for the task type (#1826, no user/project prefix)
 */
function buildKey(opts: UploadCommonOptions): string {
  return storageKey({
    taskType: opts.taskType,
    ext: opts.ext,
  });
}

/**
 * Read a local temp file and upload it to permanent storage. Returns
 * the public URL suitable for writing to a Yjs node's `content`.
 * @param opts - Temp-file upload options (local path plus common key fields)
 * @returns The permanent public URL of the uploaded object
 * @throws {Error} if the file cannot be read or the adapter upload fails
 */
export async function uploadTempFileToStorage(
  opts: UploadTempFileOptions,
): Promise<string> {
  const buffer = await readFile(opts.path);
  const adapter = await getStorageAdapter();
  return await adapter.upload(buildKey(opts), buffer, opts.contentType);
}

/**
 * Upload an in-memory Buffer directly to permanent storage — skips the
 * tempfile roundtrip for handlers whose library (e.g. Sharp) produces
 * a Buffer natively. Returns the public URL.
 * @param opts - Buffer upload options (in-memory buffer plus common key fields)
 * @returns The permanent public URL of the uploaded object
 * @throws {Error} if the adapter upload fails
 */
export async function uploadBufferToStorage(
  opts: UploadBufferOptions,
): Promise<string> {
  const adapter = await getStorageAdapter();
  return await adapter.upload(buildKey(opts), opts.buffer, opts.contentType);
}
