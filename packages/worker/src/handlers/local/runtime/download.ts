// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * Goes through the shared HTTP transport. On a bare `fetch` this had neither
 * a timeout nor a retry, and both mattered here: a stalled transfer never
 * returned, and the queue's lock extender keeps renewing the lock of a job
 * whose handler is stuck, so the job held a concurrency slot until the
 * process restarted rather than failing and being retried.
 *
 * What the transport replays is bounded, and worth being precise about: it
 * covers failures up to and including the response headers. A connection that
 * drops PART-WAY THROUGH the body is not replayed — the bytes are already
 * being written to disk, so resuming would mean range requests and partial-file
 * bookkeeping this layer does not do. Such a failure fails the job, which the
 * queue then retries from the top. That is the same outcome as before this
 * change; what improved is everything up to the first byte.
 *
 * Failure modes propagate as thrown `Error` — the caller is inside
 * `runLocalHandler` which will mark the task failed.
 */

import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, extname } from "node:path";

import { newId, httpRequest, ASSET_HEADER_TIMEOUT_MS } from "@breatic/shared";

import { httpEventLogger } from "@worker/providers/http-telemetry.js";

/**
 * Report a transfer that had to be replayed, or gave up.
 *
 * Named apart from the provider transports' telemetry so an on-call engineer
 * can tell "the vendor is degraded" from "our own object store is degraded" —
 * different owners, different fixes. Only the NAMES differ: the judgement of
 * which outcomes are worth a line is shared, because it is one rule and two
 * copies of it drift.
 */
const logDownloadEvent = httpEventLogger({
  retry: "asset_download_retry",
  gaveUp: "asset_download_gave_up",
});

/**
 * Download a URL into a job temp dir. Returns the downloaded path.
 * @param url - http(s) URL. Local paths and data URLs are not supported.
 * @param tempDir - Absolute temp dir (from `createJobTempDir`)
 * @param options - Download options
 * @param options.suffix - File extension override (e.g. `".mp4"`).
 *   When absent, derived from the URL path; falls back to `.bin`.
 * @returns Absolute path to the downloaded file
 * @throws {Error} On a non-ok status, a transfer that produced no bytes, or
 *   a transport failure that survived its replays.
 */
export async function downloadToTempDir(
  url: string,
  tempDir: string,
  options: { suffix?: string } = {},
): Promise<string> {
  const response = await httpRequest(
    url,
    {},
    {
      // Fetching an asset again has no side effects: it is a read, and the
      // bytes land in a temp file this function owns.
      replaySafe: true,
      timeoutMs: ASSET_HEADER_TIMEOUT_MS,
      onEvent: logDownloadEvent,
      label: "asset-download",
    },
  );
  if (!response.ok) {
    throw new Error(`Download failed: ${url} → HTTP ${response.status}`);
  }

  const suffix = options.suffix ?? deriveSuffixFromUrl(url);
  const filename = `${newId()}${suffix}`;
  const path = join(tempDir, `in-${filename}`);

  // The guarded stream carries the body's idle deadline with it, so a
  // transfer that stops mid-file aborts here instead of hanging the job.
  const nodeStream = Readable.fromWeb(
    response.stream() as Parameters<typeof Readable.fromWeb>[0],
  );
  await pipeline(nodeStream, createWriteStream(path));

  // Checked after the fact rather than by inspecting `response.body`: a
  // present-but-empty body is just as unusable to ffmpeg as an absent one,
  // and only the written file proves which we got.
  //
  // There is deliberately no content-length comparison. Measured
  // against a real chunked server: when a
  // length IS declared, a body that falls short makes the client throw and the
  // pipeline above rejects — a check here would be redundant. When none is
  // declared (a chunked response), the short read is silent, and no check can
  // change that because there is no declared number to compare against. The
  // gap is left open knowingly; our own storage and every vendor we fetch from
  // sends a content-length. Pinned in the tests as a known limit rather than
  // papered over.
  const { size } = await stat(path);
  if (size === 0) {
    throw new Error(`Download failed: ${url} → received 0 bytes`);
  }

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
