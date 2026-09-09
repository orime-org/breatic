// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Read a raw request body into memory with a hard byte ceiling.
 *
 * For the small uploads that must come THROUGH the server rather than through
 * the ingest Worker — today, studio avatars. The streaming upload path
 * (`adapter.uploadStream`) cannot serve them: it is implemented only by local
 * storage, because S3 and OSS expect the browser to PUT directly and never
 * see these bytes at all.
 *
 * Buffering is not the same mistake as the OOM this repo already fixed. That
 * one read whatever the client claimed to send; this one counts as it reads
 * and aborts the moment the total passes `maxBytes`, so the memory a request
 * can cost is bounded before it is spent.
 */

import type { Context } from "hono";
import { AppError } from "@breatic/core";
import { t } from "@breatic/shared";

/**
 * Read the request body, refusing anything over `maxBytes`.
 *
 * Two gates, because either alone leaves a hole:
 *   1. `Content-Length`, when present and over the cap — refuse without
 *      reading a single byte.
 *   2. A running total while reading — the header is a claim, not a promise,
 *      and a chunked request carries no length at all.
 *
 * A missing `Content-Length` must NOT be refused: chunked transfer is legal
 * and common, and rejecting it would also make gate 2 unreachable, which is
 * the gate that actually holds.
 * @param c - The Hono request context
 * @param maxBytes - Hard ceiling; the first byte past it aborts the read
 * @returns The complete body
 * @throws {AppError} 413 when the body exceeds `maxBytes`, 422 when there is
 *   no body at all
 */
export async function readBoundedBody(
  c: Context,
  maxBytes: number,
): Promise<Buffer> {
  const declared = c.req.header("Content-Length");
  if (declared !== undefined) {
    const length = Number(declared);
    // A non-numeric or negative header is a malformed request, not a large
    // one — fall through to gate 2 rather than trusting it either way.
    if (Number.isFinite(length) && length > maxBytes) {
      throw new AppError(413, t("server.error.upload_too_large"));
    }
  }

  const body = c.req.raw.body;
  if (body === null) {
    throw new AppError(422, t("server.error.validation"));
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the sender rather than draining a body we have already
        // decided to refuse.
        await reader.cancel();
        throw new AppError(413, t("server.error.upload_too_large"));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    throw new AppError(422, t("server.error.validation"));
  }
  return Buffer.concat(chunks);
}
