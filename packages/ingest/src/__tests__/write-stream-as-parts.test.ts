// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Telling a source that breaks mid-body apart from a store that refuses a part.
 *
 * Both reject inside the same transfer, and they belong to different parties:
 * the first is whoever serves the link, the second is us.
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { SourceReadError, writeStreamAsParts } from "@ingest/stored-object.js";

const PART_SIZE = 5 * 1024 * 1024;

let seq = 0;

/**
 * A body that delivers some bytes and then fails.
 * @returns The stream.
 */
function bodyThatBreaks(): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(1024));
        return;
      }
      controller.error(new Error("connection reset mid-body"));
    },
  });
}

describe("writeStreamAsParts", () => {
  it("rejects with a SourceReadError carrying the source's own error", async () => {
    const key = `image/2026-10-06/${seq++}_broken.png`;
    const upload = await env.BUCKET.createMultipartUpload(key);

    const failure = await writeStreamAsParts(
      env.BUCKET,
      key,
      upload.uploadId,
      bodyThatBreaks(),
      PART_SIZE,
      4,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(SourceReadError);
    expect((failure as SourceReadError).cause).toEqual(new Error("connection reset mid-body"));
  });

  it("rejects with the store's error when the store refuses a part", async () => {
    const key = `image/2026-10-06/${seq++}_store.png`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });

    const failure = await writeStreamAsParts(
      env.BUCKET,
      key,
      "an-upload-r2-never-opened",
      body,
      PART_SIZE,
      4,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SourceReadError);
  });
});
