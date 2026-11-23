// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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

  it("logs why an encode threw before reporting the segment failed", async () => {
    const deps = dependencies();
    deps.encode.mockRejectedValue(new Error("The stream read failed: the source stopped at 20000 of 40000 bytes"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await runLongMediaSegment(request, deps);

      expect(error).toHaveBeenCalledWith("long_media_segment_encode_failed", { report: request.reportUrl, mediaKind: "video", interval: { startUs: "0", endUs: "1000000" }, err: "The stream read failed: the source stopped at 20000 of 40000 bytes" });
      expect(deps.report).toHaveBeenCalledWith(request.reportUrl, "failed");
      expect(deps.write).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
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
  const realFetch = globalThis.fetch;
  let dir: string;
  let server: Server;
  let objectUrl: string;
  // The next upstream answer from this byte stops after `after` body bytes and closes its connection.
  let drop: { from: number; after: number } | null = null;
  let dropped = false;

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
      if (drop !== null && drop.from === from) {
        const after = drop.after;
        [drop, dropped] = [null, true];
        response.write(bytes.subarray(from, from + after), () => incoming.socket.destroy());
        return;
      }
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
   * Encode the segment from frame n's presentation time for ten frames.
   * @param n - The first frame.
   * @returns The segment written, or null when none was.
   */
  async function segment(n: number): Promise<Uint8Array | null> {
    let written: Uint8Array | null = null;
    // The source is read for real (the container's loopback reader fetches it); the output write and report are caught.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === undefined || init.method === "GET") return realFetch(input, init);
      if (init.method === "PUT") written = new Uint8Array(await new Response(init.body).arrayBuffer());
      return new Response(null, { status: 200 });
    }));
    const startUs = 80_000 + 40_000 * n;
    await runLongMediaSegment({ ...request, objectUrl, interval: { startUs: String(startUs), endUs: String(startUs + 400_000) }, deadlineAt: Date.now() + 600_000 });
    return written;
  }

  /**
   * Encode the segment from frame n's presentation time for ten frames and read the frame number of each frame it holds.
   * @param n - The first frame.
   * @returns The frame numbers, by luma.
   */
  async function segmentFrames(n: number): Promise<number[]> {
    const written = await segment(n);
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
   }, 120_000);

  // The seek-landing probe of the segment from frame 9 lands on the keyframe presented at frame 10 and moves back. This
  // small source is read whole (the moov after the media data) by the first request, then from byte 48 for the packet.
  it.each([
    ["the read of the landing packet", { from: 48, after: 3000 }],
    ["the read of the moov", { from: 0, after: 19_300 }],
  ])("resumes a connection dropped inside %s of its seek probe and writes the undisturbed segment", async (_read, at) => {
    const undisturbed = await segment(9);
    expect(undisturbed).not.toBeNull();
    [drop, dropped] = [at, false];
    const resumed = await segment(9);
    expect(dropped, "the upstream answer was dropped").toBe(true);
    expect(resumed).toEqual(undisturbed);
  }, 60_000);
});

// A fragmented MP4 with B-frames and a trailing mfra index, as FFmpeg's frag_keyframe writes it: the seek probe searches
// that index, so the segment's own decode must open the file the same way or it lands on a later keyframe than the probe
// judged. Every frame n has luma 20 + 2n; its presentation time is read from the file; keyframes every 30 frames.
describe("a video segment of a fragmented B-frame MP4 with an mfra index", () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let server: Server;
  let objectUrl: string;
  let ptsUs: number[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "long-media-segment-frag-"));
    const source = join(dir, "source.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=3,format=yuv420p,geq=lum='20+2*N':cb=128:cr=128", "-f", "lavfi", "-i", "sine=f=440:d=3",
      "-c:v", "libx264", "-qp", "1", "-bf", "3", "-x264-params", "b-adapt=0:colorprim=bt709:transfer=bt709:colormatrix=bt709",
      "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov", source]);
    ptsUs = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", source])
      .toString().trim().split("\n").map((line) => Math.round(Number(line) * 1e6));
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

  it("holds the ten frames presented from its start on, from starts on both sides of a keyframe", async () => {
    const wrong: string[] = [];
    for (const n of [26, 27, 28, 29, 30, 31, 57, 58, 59, 60]) {
      let written: Uint8Array | null = null;
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === undefined || init.method === "GET") return realFetch(input, init);
        if (init.method === "PUT") written = new Uint8Array(await new Response(init.body).arrayBuffer());
        return new Response(null, { status: 200 });
      }));
      await runLongMediaSegment({ ...request, objectUrl, interval: { startUs: String(ptsUs[n]), endUs: String(ptsUs[n + 10]) }, deadlineAt: Date.now() + 600_000 });
      expect(written, `the segment from frame ${n} was written`).not.toBeNull();
      const output = join(dir, `segment-${n}.mp4`);
      await writeFile(output, written!);
      const planes = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=16:16:24:24", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 });
      const frames = Array.from({ length: planes.length / 384 }, (_unused, frame) =>
        Math.round((planes.subarray(frame * 384, frame * 384 + 256).reduce((sum, value) => sum + value, 0) / 256 - 20) / 2));
      const expected = Array.from({ length: 10 }, (_unused, k) => n + k);
      if (JSON.stringify(frames) !== JSON.stringify(expected)) wrong.push(`from ${n}: ${frames.join(",")}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});

describe("a segment whose source connection drops mid-read, encoded by the container's own encoder", () => {
  let dir: string;
  let source: Buffer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "long-media-segment-drop-"));
    const path = join(dir, "source.mp3");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=3", "-c:a", "libmp3lame", path]);
    source = await readFile(path);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Encode the audio segment from 0.5 s to 2.5 s off a source served as the Worker serves it, whose first answer may
   * close its connection after `dropAt` body bytes while declaring the full length.
   * @param dropAt - Where the first answer stops, or null for none.
   * @param ranges - Whether the server offers byte ranges.
   * @returns The segment written, or null, and what was reported.
   */
  async function encodeServed(dropAt: number | null, ranges: boolean): Promise<{ written: Buffer | null; reported: unknown }> {
    let dropping = dropAt !== null;
    let written: Buffer | null = null;
    let reported: unknown = null;
    const server = createServer((incoming, response) => {
      if (incoming.method === "PUT" || incoming.method === "POST") {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          if (incoming.method === "PUT") written = Buffer.concat(chunks);
          else reported = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          response.writeHead(200).end();
        });
        return;
      }
      const range = ranges ? /^bytes=(\d+)-/.exec(incoming.headers.range ?? "") : null;
      const from = range === null ? 0 : Number(range[1]);
      response.writeHead(range === null ? 200 : 206, { "content-length": source.length - from, ...(ranges && { "accept-ranges": "bytes" }),
        ...(range !== null && { "content-range": `bytes ${from}-${source.length - 1}/${source.length}` }) });
      if (dropping) {
        dropping = false;
        response.write(source.subarray(from, dropAt!), () => incoming.socket.destroy());
        return;
      }
      response.end(source.subarray(from));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await runLongMediaSegment({ ...request, objectUrl: `${origin}/source.mp3`, outputUrl: `${origin}/segment.mp3`, reportUrl: `${origin}/report`,
        mediaKind: "audio", interval: { startUs: "500000", endUs: "2500000" }, deadlineAt: Date.now() + 600_000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return { written, reported };
  }

  it("resumes the read and writes the segment the whole source gives", async () => {
    const whole = await encodeServed(null, true);
    expect(whole.written?.length).toBeGreaterThan(30_000);
    const dropped = await encodeServed(2048, true);
    expect(dropped).toEqual(whole);
   }, 60_000);

  it("reports a failed segment rather than write the part encoded before a drop it cannot resume", async () => {
    expect(await encodeServed(2048, false)).toEqual({ written: null, reported: { outcome: "failed" } });
   }, 60_000);
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
