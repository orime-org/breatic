// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import type { LongMediaJobRequest } from "@breatic/shared";
import type { LongMediaSegmentSnapshot } from "@ingest/jobs/long-media-container.js";
import { longMediaSegmentContainerRequest } from "@ingest/jobs/long-media-segment-request.js";

const job: LongMediaJobRequest = {
  protocolVersion: 1,
  jobId: "operation-1:source-0",
  operationId: "operation-1",
  sourceIndex: 0,
  source: { key: "source/input file.mp4", sha256: "a".repeat(64), sizeBytes: 10_000 },
  profileId: "profile-v1",
  profileVersion: "profile-v1",
  encodingProfile: {
    audioCodec: "libmp3lame",
    audioBitrate: "128k",
    videoCodec: "libx264",
    videoCrf: 23,
    videoAudioCodec: "aac",
    videoAudioBitrate: "128k",
  },
  limitsSnapshot: {
    maxSourceBytes: 20_000,
    maxSources: 1,
    maxSegmentBytes: 5_000,
    audioCoreSeconds: 30,
    videoCoreSeconds: 10,
    maxActiveLeaves: 10,
    maxConcurrentSegments: 1,
  },
  deadlineAt: 20_000,
  requestDigest: "b".repeat(64),
};

const segment: LongMediaSegmentSnapshot = {
  id: "source-video-0:0:10000000",
  mediaInputId: "source-video-0",
  descriptor: { inputKind: "source_file", mediaKind: "video" },
  core: { startUs: "0", endUs: "10000000" },
  decode: { startUs: "0", endUs: "10000000" },
  grantId: "grant-1",
  storageKey: "understand/output segment.mp4",
  measured: null,
  status: "encoding",
  version: 1,
};

describe("longMediaSegmentContainerRequest", () => {
  it("binds the source interval, exact authorized output key, profile, size limit, and deadline", () => {
    expect(longMediaSegmentContainerRequest(job, segment, {
      output: "long-media-output.local",
      report: "long-media-segment-report.local",
    })).toEqual({
      objectUrl: "http://r2.local/source/input%20file.mp4",
      outputUrl: "http://long-media-output.local/understand/output%20segment.mp4",
      reportUrl: "http://long-media-segment-report.local/segment-report/source-video-0%3A0%3A10000000",
      mediaKind: "video",
      interval: { startUs: "0", endUs: "10000000" },
      profile: job.encodingProfile,
      maxOutputBytes: 5_000,
      deadlineAt: 20_000,
    });
  });

  it("rejects segments without a current encoding grant", () => {
    expect(() => longMediaSegmentContainerRequest(job, { ...segment, status: "planned" }, {
      output: "long-media-output.local",
      report: "long-media-segment-report.local",
    })).toThrow(RangeError);
    expect(() => longMediaSegmentContainerRequest(job, { ...segment, storageKey: null }, {
      output: "long-media-output.local",
      report: "long-media-segment-report.local",
    })).toThrow(RangeError);
  });
});
