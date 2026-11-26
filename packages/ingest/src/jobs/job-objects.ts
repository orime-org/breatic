// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { IngestMeasurements } from "@breatic/shared";
import { askedKey } from "@ingest/object-url.js";
import { MEDIA_OBJECT_HOST, serveOneObject } from "@ingest/media-object-route.js";
import { hashStoredObject, sniffStoredObject, writeStreamedObject } from "@ingest/stored-object.js";

/** The established media-job multipart layout and twenty-GiB object contract. */
const PART_SIZE = 32 * 1024 * 1024;
const MAX_PARTS = 640;

/** The immutable read/write capabilities of one container attempt. */
export interface JobObjectAccess {
  reads: string[];
  writes: Record<string, string>;
  attemptId?: string;
}
/** Measurements read from the actual bytes stored by R2. */
export type JobObjectWritten = Pick<IngestMeasurements, "sha256" | "sizeBytes" | "contentType">;

/**
 * Enforce one attempt's exact stored-object read and write capabilities.
 * @param request - The intercepted container request.
 * @param bucket - The real R2 storage binding.
 * @param access - The frozen source/output keys and optional attempt.
 * @param note - Record measurements of a completed authorized write.
 * @param claim - Atomically claim a planned key before any R2 IO.
 * @returns The authorized object or a definite refusal.
 * @throws {Error} When an authorized storage write or its measurement fails.
 */
export async function serveJobObjects(
  request: Request,
  bucket: R2Bucket,
  access: JobObjectAccess,
  note: (key: string, written: JobObjectWritten, attemptId?: string, claimToken?: string) => Promise<void> | void,
  claim?: (key: string, attemptId: string) => Promise<string | null>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== MEDIA_OBJECT_HOST || (access.attemptId !== undefined && url.searchParams.get("attempt") !== access.attemptId)) {
    return new Response("Not this attempt", { status: 403 });
  }
  const key = askedKey(request);
  if (request.method === "GET" || request.method === "HEAD") {
    if (!access.reads.includes(key)) return new Response("Not this object", { status: 403 });
    return serveOneObject(request, bucket, key);
  }
  if (request.method !== "PUT" || request.body === null) return new Response("Not allowed", { status: 405 });
  const contentType = access.writes[key];
  if (contentType === undefined || access.reads.includes(key)) return new Response("Not this object", { status: 403 });
  let claimToken: string | undefined;
  if (access.attemptId !== undefined) {
    const claimed = await claim?.(key, access.attemptId);
    if (claimed === null || claimed === undefined) return new Response("Output already claimed or attempt is inactive", { status: 409 });
    claimToken = claimed;
  }
  const stored = await writeStreamedObject(bucket, key, request.body, {
    contentType, partSize: PART_SIZE, maxBytes: PART_SIZE * MAX_PARTS,
  });
  if (stored === "over_cap") return new Response("Too large", { status: 413 });
  await note(key, {
    sha256: await hashStoredObject(bucket, key), sizeBytes: stored.sizeBytes,
    contentType: await sniffStoredObject(bucket, key),
  }, access.attemptId, claimToken);
  return new Response(null, { status: 200 });
}
