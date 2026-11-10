// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
      interval: { startUs: "-500000", endUs: "59500000" },
    })).toMatchObject({ interval: { startUs: "-500000", endUs: "59500000" } });
    expect(readLongMediaSegmentRunRequest({
      ...request,
      interval: { startUs: "1", endUs: "1" },
    })).toBeNull();
    expect(readLongMediaSegmentRunRequest({
      ...request,
      interval: { startUs: "-0", endUs: "1" },
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

  it("leaves transient output retry to the authenticated output route", async () => {
    const deps = dependencies();
    deps.encode.mockResolvedValue(Buffer.from("segment"));
    deps.write.mockResolvedValue(503);

    await runLongMediaSegment(request, deps);

    expect(deps.report).not.toHaveBeenCalled();
  });

  it("reports an expired deadline without starting the encoder", async () => {
    const deps = dependencies();
    deps.now.mockReturnValue(request.deadlineAt);

    await runLongMediaSegment(request, deps);

    expect(deps.report).toHaveBeenCalledWith(request.reportUrl, "failed");
    expect(deps.encode).not.toHaveBeenCalled();
  });
});

// The mov demuxer of an MP4 with B-frames and no edit list searches a seek time on the decode clock, which runs two frames
// behind the presentation clock here, so a seek to a time just before a keyframe lands on that keyframe. Every frame n of
// the fixture has luma 20 + 4n and is presented at 0.08 + n / 25 s; keyframes every 10 frames.
describe("a video segment of a B-frame MP4 without an edit list, encoded by the container's own encoder", () => {
  let dir: string;
  let server: Server;
  let objectUrl: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "long-media-segment-"));
    const source = join(dir, "source.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=2,format=yuv420p,geq=lum='20+4*N':cb=128:cr=128", "-f", "lavfi", "-i", "sine=f=440:d=2",
      "-c:v", "libx264", "-qp", "1", "-bf", "2", "-x264-params", "b-adapt=0:colorprim=bt709:transfer=bt709:colormatrix=bt709", "-g", "10",
      "-pix_fmt", "yuv420p", "-video_track_timescale", "25", "-c:a", "aac", "-use_editlist", "0", source]);
    const bytes = await readFile(source);
    server = createServer((incoming, response) => {
      const range = /^bytes=(\d+)-(\d*)/.exec(incoming.headers.range ?? "");
      const from = range === null ? 0 : Number(range[1]);
      const to = range === null || range[2] === "" ? bytes.length - 1 : Number(range[2]);
      response.writeHead(range === null ? 200 : 206, { "content-type": "video/mp4", "content-length": to - from + 1, "accept-ranges": "bytes",
        ...(range === null ? {} : { "content-range": `bytes ${from}-${to}/${bytes.length}` }) });
      response.end(bytes.subarray(from, to + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    objectUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/source.mp4`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  /**
   * Encode the segment from frame n's presentation time for ten frames and read the frame number of each frame it holds.
   * @param n - The first frame.
   * @returns The frame numbers, by luma.
   */
  async function segmentFrames(n: number): Promise<number[]> {
    let written: Uint8Array | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") written = new Uint8Array(await new Response(init.body).arrayBuffer());
      return new Response(null, { status: 200 });
    }));
    const startUs = 80_000 + 40_000 * n;
    await runLongMediaSegment({ ...request, objectUrl, interval: { startUs: String(startUs), endUs: String(startUs + 400_000) }, deadlineAt: Date.now() + 600_000 });
    expect(written, `the segment from frame ${n} was written`).not.toBeNull();
    const output = join(dir, `segment-${n}.mp4`);
    await writeFile(output, written!);
    const planes = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=16:16:24:24", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 });
    return Array.from({ length: planes.length / 384 }, (_unused, frame) => {
      const luma = planes.subarray(frame * 384, frame * 384 + 256).reduce((sum, value) => sum + value, 0) / 256;
      return Math.round((luma - 20) / 4);
    });
  }

  it("holds the ten frames presented from its start on, from every start", async () => {
    const wrong: string[] = [];
    for (let n = 1; n <= 14; n += 1) {
      const frames = await segmentFrames(n);
      const expected = Array.from({ length: 10 }, (_unused, k) => n + k);
      if (JSON.stringify(frames) !== JSON.stringify(expected)) wrong.push(`from ${n}: ${frames.join(",")}`);
    }
    expect(wrong).toEqual([]);
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
