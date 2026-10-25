// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  computeLongMediaJobRequestDigest,
  LongMediaJobRequestSchema,
  readLongMediaJobRequest,
  verifyLongMediaJobRequest,
} from "@shared/media/long-media-job.js";

const request = {
  protocolVersion: 1 as const,
  jobId: "operation-1:source-0",
  operationId: "operation-1",
  sourceIndex: 0,
  source: {
    key: "studio/project/source.mp4",
    sha256: "a".repeat(64),
    sizeBytes: 1_000_000,
    etag: "etag-1",
  },
  profileId: "channel-v1",
  profileVersion: "channel-v1",
  limitsSnapshot: {
    maxSourceBytes: 2_147_483_648,
    maxSources: 10,
    maxSegmentBytes: 20_000_000,
    audioCoreSeconds: 300,
    videoCoreSeconds: 60,
    overlapSeconds: 2,
    maxActiveLeaves: 512,
  },
  deadlineAt: 1_800_000_000_000,
  requestDigest: "b".repeat(64),
};

describe("long media job requests", () => {
  it("accepts the versioned immutable source and budget snapshot", () => {
    expect(readLongMediaJobRequest(request)).toEqual(request);
  });

  it("rejects unknown fields at every request boundary", () => {
    expect(LongMediaJobRequestSchema.safeParse({ ...request, studioId: "studio-1" }).success).toBe(false);
    expect(LongMediaJobRequestSchema.safeParse({ ...request, source: { ...request.source, url: "https://example.invalid" } }).success).toBe(false);
    expect(LongMediaJobRequestSchema.safeParse({ ...request, limitsSnapshot: { ...request.limitsSnapshot, unbounded: true } }).success).toBe(false);
  });

  it("rejects unsupported versions, invalid source fingerprints, and invalid limits", () => {
    expect(LongMediaJobRequestSchema.safeParse({ ...request, protocolVersion: 2 }).success).toBe(false);
    expect(LongMediaJobRequestSchema.safeParse({ ...request, source: { ...request.source, sha256: "not-a-digest" } }).success).toBe(false);
    expect(LongMediaJobRequestSchema.safeParse({ ...request, limitsSnapshot: { ...request.limitsSnapshot, maxActiveLeaves: 0 } }).success).toBe(false);
  });

  it("fails closed when a caller reads a malformed job request", () => {
    expect(() => readLongMediaJobRequest({ ...request, deadlineAt: -1 })).toThrow("The long media job request is invalid");
  });

  it("binds the request digest to the immutable job payload", async () => {
    const { requestDigest: _requestDigest, ...payload } = request;
    const digest = await computeLongMediaJobRequestDigest(payload);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyLongMediaJobRequest({ ...payload, requestDigest: digest })).resolves.toMatchObject(payload);
    await expect(verifyLongMediaJobRequest({ ...payload, requestDigest: "c".repeat(64) })).rejects.toThrow(
      "The long media job request digest does not match its payload",
    );
  });
});
