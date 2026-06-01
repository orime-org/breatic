/**
 * Download a remote asset URL to a local path inside the job temp dir.
 *
 * All mini-tool inputs in Breatic arrive as OSS/S3/local URLs — never
 * as raw bytes or data URLs (see `packages/core/src/infra/storage.ts`).
 * This utility abstracts "fetch that URL to disk" for local handlers.
 *
 * Local handlers should NOT talk to OSS SDKs directly; they should use
 * this helper so credentials + region config stay in one place.
 *
 * Failure modes propagate as thrown `Error` — the caller is inside
 * `runLocalHandler` which will mark the task failed.
 */

import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Download a URL into a job temp dir. Returns the downloaded path.
 * @param url - http(s) URL. Local paths and data URLs are not supported.
 * @param tempDir - Absolute temp dir (from `createJobTempDir`)
 * @param options - Download options
 * @param options.suffix - File extension override (e.g. `".mp4"`).
 *   When absent, derived from the URL path; falls back to `.bin`.
 * @returns Absolute path to the downloaded file
 */
export async function downloadToTempDir(
  url: string,
  tempDir: string,
  options: { suffix?: string } = {},
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${url} → HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`Download failed: ${url} → empty response body`);
  }

  const suffix = options.suffix ?? deriveSuffixFromUrl(url);
  const filename = `${randomBytes(6).toString("hex")}${suffix}`;
  const path = join(tempDir, `in-${filename}`);

  const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(path));
  return path;
}

/**
 * Derive a file extension from a URL's pathname, falling back to `.bin`.
 * @param url - The asset URL to inspect
 * @returns The extension including the leading dot, or `.bin` when none can be parsed
 */
function deriveSuffixFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const ext = extname(parsed.pathname);
    return ext || ".bin";
  } catch {
    return ".bin";
  }
}
