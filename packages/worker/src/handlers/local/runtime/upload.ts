// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storing a local handler's output (#181, lane ②).
 *
 * The CLI handlers (FFmpeg, ImageMagick) land their output on disk, so this
 * reads it back and sends it through the ingest Worker, which is what files it
 * in the ledger and computes the hash over what landed. Before #181 it went
 * straight to storage and was never registered at all — a transformation the
 * user can see on their canvas that counted toward nobody's storage.
 */

import { openAsBlob } from "node:fs";
import { storeBytes } from "@worker/handlers/backend-upload.js";

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

/**
 * Read a local temp file and store it. Returns the public URL suitable for
 * writing to a Yjs node's `content`.
 * The file is handed over as a file-backed Blob, so each part is read as it is
 * sent. An ffmpeg output can run to hundreds of megabytes, and reading it whole
 * would hold all of it for as long as the upload takes.
 * @param opts - Temp-file upload options (local path plus common key fields)
 * @returns The registered row's canonical URL
 * @throws {Error} if the file cannot be read, or the bytes could not be stored
 *   or filed
 */
export async function uploadTempFileToStorage(
  opts: UploadTempFileOptions,
): Promise<string> {
  const stored = await storeBytes(
    await openAsBlob(opts.path),
    {
      projectId: opts.projectId,
      actingUserId: opts.userId,
      // A mini-tool's output is something we produced, not something the user
      // handed us — the same source a generation's output is filed under.
      assetSource: "ai",
      taskType: opts.taskType,
      ext: opts.ext,
      contentType: opts.contentType,
    },
  );
  return stored.fileUrl;
}
