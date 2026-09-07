// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storing a local handler's output (#181, lane ②).
 *
 * Two forms:
 *   - `uploadTempFileToStorage({ path, ... })` for CLI-based handlers
 *     (FFmpeg, ImageMagick) that land their output on disk.
 *   - `uploadBufferToStorage({ buffer, ... })` for in-process library
 *     handlers (Sharp, etc.) that hold the output as a Buffer and want
 *     to skip the tempfile roundtrip.
 *
 * Both send the bytes through the ingest Worker, which is what files them in
 * the ledger and computes the hash over what landed. Before #181 these went
 * straight to storage and were never registered at all — a transformation the
 * user can see on their canvas that counted toward nobody's storage.
 */

import { readFile } from "node:fs/promises";
import { backendUploadService } from "@breatic/domain";

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
  /** Project the output belongs to; it decides the owner studio. */
  projectId: string;
  /** Who the stored asset is attributed to. */
  userId: string;
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
 * Send a local handler's bytes to R2 and hand back the url the node pins.
 * @param bytes - What the handler produced.
 * @param opts - Where it belongs and what it is.
 * @returns The registered row's canonical URL.
 * @throws {Error} When the bytes could not be stored or filed.
 */
async function store(
  bytes: Buffer,
  opts: UploadCommonOptions,
): Promise<string> {
  const stored = await backendUploadService.uploadBytesToStorage(bytes, {
    projectId: opts.projectId,
    actingUserId: opts.userId,
    // A mini-tool's output is something we produced, not something the user
    // handed us — the same source a generation's output is filed under.
    assetSource: "ai",
    taskType: opts.taskType,
    ext: opts.ext,
    contentType: opts.contentType,
  });
  if (stored.fileUrl === undefined) {
    throw new Error(`stored output for project ${opts.projectId} came back with no url`);
  }
  return stored.fileUrl;
}

/**
 * Read a local temp file and store it. Returns the public URL suitable for
 * writing to a Yjs node's `content`.
 * @param opts - Temp-file upload options (local path plus common key fields)
 * @returns The permanent public URL of the stored object
 * @throws {Error} if the file cannot be read or the upload fails
 */
export async function uploadTempFileToStorage(
  opts: UploadTempFileOptions,
): Promise<string> {
  return store(await readFile(opts.path), opts);
}

/**
 * Store an in-memory Buffer directly — skips the tempfile roundtrip for
 * handlers whose library (e.g. Sharp) produces a Buffer natively.
 * @param opts - Buffer upload options (in-memory buffer plus common key fields)
 * @returns The permanent public URL of the stored object
 * @throws {Error} if the upload fails
 */
export async function uploadBufferToStorage(
  opts: UploadBufferOptions,
): Promise<string> {
  return store(opts.buffer, opts);
}
