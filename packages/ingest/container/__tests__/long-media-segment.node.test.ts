// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";

import {
  readLongMediaSegmentRunRequest,
  runLongMediaSegment,
  type LongMediaSegmentRunRequest,
} from "../long-media-segment.js";

const request: LongMediaSegmentRunRequest = {
  objectUrl: "http://r2.local/source.mp4",
  outputUrl: "http://long-media-output.local/segment.mp4",
  reportUrl: "http://long-media.local/segment-report",
  mediaKind: "video",
  interval: { startUs: "0", endUs: "1000000" },
  profile: {
    audioCodec: "libmp3lame",
    audioBitrate: "128k",
    videoCodec: "libx264",
    videoCrf: 23,
    videoAudioCodec: "aac",
    videoAudioBitrate: "128k",
  },
  maxOutputBytes: 20_000_000,
  deadlineAt: 1_800_000_000_000,
};

describe("runLongMediaSegment", () => {
  it("accepts a complete request and rejects malformed protocol values", () => {
    expect(readLongMediaSegmentRunRequest(request)).toEqual(request);
    expect(readLongMediaSegmentRunRequest({
      ...request,
      interval: { startUs: "1", endUs: "1" },
    })).toBeNull();
    expect(readLongMediaSegmentRunRequest({ ...request, unexpected: true })).toBeNull();
  });

  it("writes one encoded source-time segment to its assigned output", async () => {
    const deps = dependencies();
    deps.encode.mockResolvedValue(Buffer.from("segment"));
    deps.write.mockResolvedValue(200);

    await runLongMediaSegment(request, deps);

    expect(deps.encode).toHaveBeenCalledWith(
      request.objectUrl,
      request.mediaKind,
      request.interval,
      request.profile,
      request.maxOutputBytes,
      expect.any(AbortSignal),
    );
    expect(deps.write).toHaveBeenCalledWith(request.outputUrl, Buffer.from("segment"), expect.any(AbortSignal));
    expect(deps.report).not.toHaveBeenCalled();
  });

  it("reports an over-cap encoded segment for source-time repartitioning", async () => {
    const deps = dependencies();
    deps.encode.mockResolvedValue("over_cap");

    await runLongMediaSegment(request, deps);

    expect(deps.report).toHaveBeenCalledWith(request.reportUrl, "oversize");
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("reports encoding failure and does not write partial bytes", async () => {
    const deps = dependencies();
    deps.encode.mockResolvedValue(null);

    await runLongMediaSegment(request, deps);

    expect(deps.report).toHaveBeenCalledWith(request.reportUrl, "failed");
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("reports an output-write refusal as a failed segment", async () => {
    const deps = dependencies();
    deps.encode.mockResolvedValue(Buffer.from("segment"));
    deps.write.mockResolvedValue(502);

    await runLongMediaSegment(request, deps);

    expect(deps.report).toHaveBeenCalledWith(request.reportUrl, "failed");
  });

  it("reports an expired deadline without starting the encoder", async () => {
    const deps = dependencies();
    deps.now.mockReturnValue(request.deadlineAt);

    await runLongMediaSegment(request, deps);

    expect(deps.report).toHaveBeenCalledWith(request.reportUrl, "failed");
    expect(deps.encode).not.toHaveBeenCalled();
  });
});

/** Create a deterministic segment runner dependency set. */
function dependencies(): {
  encode: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
} {
  return {
    encode: vi.fn().mockResolvedValue(Buffer.from("segment")),
    write: vi.fn().mockResolvedValue(200),
    report: vi.fn().mockResolvedValue(undefined),
    now: vi.fn().mockReturnValue(request.deadlineAt - 1_000),
  };
}
