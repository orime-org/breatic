// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";

import { SourceReadError, writeStreamedObject } from "@ingest/stored-object.js";

describe("writeStreamedObject", () => {
  it("aborts the R2 multipart upload when the input stream fails", async () => {
    const abort = vi.fn(async () => undefined);
    const bucket = {
      createMultipartUpload: vi.fn(async () => ({ uploadId: "upload-1", abort })),
      resumeMultipartUpload: vi.fn(() => ({ uploadPart: vi.fn(async () => ({ etag: "part-1" })) })),
    } as unknown as R2Bucket;
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.error(new Error("container stream ended"));
      },
    });

    await expect(writeStreamedObject(bucket, "segment.mp4", body, {
      contentType: "video/mp4",
      partSize: 5,
      maxBytes: 10,
    })).rejects.toBeInstanceOf(SourceReadError);

    expect(abort).toHaveBeenCalledOnce();
  });

  it("aborts the multipart upload when completion fails before an object exists", async () => {
    const abort = vi.fn(async () => undefined);
    const bucket = {
      createMultipartUpload: vi.fn(async () => ({
        uploadId: "upload-1",
        abort,
        complete: vi.fn(async () => { throw new Error("completion failed"); }),
      })),
      resumeMultipartUpload: vi.fn(() => ({
        uploadPart: vi.fn(async () => ({ etag: "part-1" })),
      })),
      head: vi.fn(async () => null),
    } as unknown as R2Bucket;
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    await expect(writeStreamedObject(bucket, "segment.mp4", body, {
      contentType: "video/mp4",
      partSize: 5,
      maxBytes: 10,
    })).rejects.toThrow("completion failed");

    expect(abort).toHaveBeenCalledOnce();
  });
});
