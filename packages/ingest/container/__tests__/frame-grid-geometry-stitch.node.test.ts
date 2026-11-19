// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The display geometry the probe plans, the stitch's encode-header check and the HDR edit-friendly file (inner#1306 test
 * plan §65.3 R05, R07, R10; frames-split design §4.3 旋转/SAR row and 色彩/HDR/位深 row, §4.2 HDR row, §5.4 拼接 row).
 *
 * R05: `P.display` is the first frame FFmpeg's default decode gives (container cropping and autorotation applied), read with
 * `showinfo`, then made square by its SAR; ffprobe's stream size is not it (a Matroska PixelCrop or an MP4 clean aperture).
 * The probe request below is the current presentation run contract's; it moves with the contract's §5.4 rate keys.
 * R07: a stitch compares its chunks' encode headers (H.264 avcC SPS/PPS, VP9 codec private and alpha) and fails the output
 * when they differ. R10: an HLG ProRes source's edit-friendly file is tone mapped once, in `edit_encode`, to SDR BT.709.
 * Every sample is made here with FFmpeg.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as runOwner from "@ingest/container/presentation-run.js";
import { presentationProbeAnswerSchema, presentationRunRequestSchema } from "@ingest/presentation-run-contract.js";
import { writePixelCropped } from "./helpers/matroska-pixel-crop.js";
import { NOISE, gridOf, mad, produce, rawFrames, run, runJob, stubContainerFetch, type GridFacts } from "./helpers/frame-grid-harness.js";

const SOURCE = "10000000-0000-4000-8000-000000000001";
const CHUNK_A = "10000000-0000-4000-8000-0000000000a1";
const CHUNK_B = "10000000-0000-4000-8000-0000000000b1";
const SOURCE_BASE = "http://source.test/";

// The current presentation run contract's request constants (as presentation-probe.node.test.ts sends them).
const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000, sdr_16bit: 294000000, hdr_16bit: 71900000 }, aacEncodeSecondsPerSecond: 100 },
  copyDiskMarginBytes: 33554432, carrier: { maxShortSide: 1080, color: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } },
};
const PROBE_LIMITS = {
  maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: "medium", probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536,
  sourceLedger: { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 },
};
const IDENTITY_FORMATS = [{ container: "mp4", videoCodec: "h264", profiles: ["Constrained Baseline", "Baseline", "Main", "High"], pixFmt: "yuv420p", bitDepth: 8, audioCodecs: ["aac", "none"], rotation: 0, sar: "1:1", matrixTagged: true }];
const PROBE = { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: IDENTITY_FORMATS };

let dir: string;
const files = new Map<string, string>();
let hlg: GridFacts;

/**
 * Make one sample with FFmpeg.
 * @param name - Its file name.
 * @param args - Arguments before the output path.
 * @returns Its path.
 */
async function make(name: string, args: string[]): Promise<string> {
  const path = join(dir, name);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, path]);
  files.set(name, path);
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "frame-grid-geometry-"));
  // R05: §4.3's own examples, a VP9 WebM 160x96 cropped left 3, right 1, bottom 1, and H.264 cropped right 1, bottom 1; an MP4
  // clean aperture (FFmpeg writes a Matroska PixelCrop into MP4 as clap); a 360x240 picture stored at SAR 4:3.
  await make("w.webm", ["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=0.4", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p"]);
  await writePixelCropped(join(dir, "w.webm"), join(dir, "crop-lrb.webm"), { left: 3, right: 1, bottom: 1 });
  files.set("crop-lrb.webm", join(dir, "crop-lrb.webm"));
  await make("h.mkv", ["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  await writePixelCropped(join(dir, "h.mkv"), join(dir, "crop-rb.mkv"), { right: 1, bottom: 1 });
  files.set("crop-rb.mkv", join(dir, "crop-rb.mkv"));
  await writePixelCropped(join(dir, "h.mkv"), join(dir, "crop-lt.mkv"), { left: 3, top: 1 });
  await make("clap.mp4", ["-i", join(dir, "crop-lt.mkv"), "-map", "0:v", "-c", "copy"]);
  await make("sar43.mp4", ["-f", "lavfi", "-i", "testsrc2=s=360x240:r=25:d=0.4", "-vf", "setsar=4/3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  // R07: a source with audio, and chunks of its frames 0–24 and 25–49 encoded alike, or with another preset (CAVLC under
  // ultrafast, so the PPS differs); VP9 chunks with and without an alpha plane.
  const source = await make("src.mp4", ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=2",
    "-c:v", "libx264", "-g", "25", "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  const h264 = ["-c:v", "libx264", "-g", "25", "-bf", "0", "-pix_fmt", "yuv420p", "-crf", "18"];
  await make("a.mp4", ["-i", source, "-map", "0:v", "-vf", "trim=end_frame=25,setpts=PTS-STARTPTS", ...h264, "-preset", "medium"]);
  await make("b.mp4", ["-i", source, "-map", "0:v", "-vf", "trim=start_frame=25:end_frame=50,setpts=PTS-STARTPTS", ...h264, "-preset", "medium"]);
  await make("b-fast.mp4", ["-i", source, "-map", "0:v", "-vf", "trim=start_frame=25:end_frame=50,setpts=PTS-STARTPTS", ...h264, "-preset", "ultrafast"]);
  const vp9 = (format: string): string[] => ["-c:v", "libvpx-vp9", "-pix_fmt", format, "-deadline", "realtime", "-cpu-used", "8", "-auto-alt-ref", "0"];
  await make("va.webm", ["-i", source, "-map", "0:v", "-vf", "trim=end_frame=25,setpts=PTS-STARTPTS,format=yuva420p", ...vp9("yuva420p")]);
  await make("vb.webm", ["-i", source, "-map", "0:v", "-vf", "trim=start_frame=25:end_frame=50,setpts=PTS-STARTPTS,format=yuva420p", ...vp9("yuva420p")]);
  await make("vb-opaque.webm", ["-i", source, "-map", "0:v", "-vf", "trim=start_frame=25:end_frame=50,setpts=PTS-STARTPTS", ...vp9("yuv420p")]);
  // R10: HLG ProRes 4:2:2 10-bit, tagged BT.2020 NCL, ARIB STD-B67.
  const hdr = await make("hlg.mov", ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=1,format=yuv422p10le,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv",
    "-c:v", "prores_ks", "-profile:v", "3"]);
  hlg = await gridOf(hdr, { numerator: 25, denominator: 1 });
}, 120_000);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(() => {
  stubContainerFetch();
  const contained = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const path = files.get(url.slice(SOURCE_BASE.length));
    if (!url.startsWith(SOURCE_BASE)) return contained(input, init);
    if (path === undefined) return new Response("missing", { status: 404 });
    const bytes = await readFile(path);
    return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
  });
});

/**
 * The first frame FFmpeg's default decode gives, made square by its SAR (§4.3): SAR above 1 widens, below 1 heightens,
 * rounded; 0:1 reads as 1:1.
 * @param path - The file.
 * @returns The display size.
 */
async function firstFrameDisplay(path: string): Promise<{ width: number; height: number }> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-v", "info", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"]);
  const line = stderr.split("\n").find((entry) => entry.includes("Parsed_showinfo") && entry.includes(" s:"))!;
  const [, width, height] = /s:(\d+)x(\d+)/u.exec(line)!.map(Number);
  const [, num, den] = /sar:(\d+)\/(\d+)/u.exec(line)!.map(Number);
  const sar = num === 0 || den === 0 ? 1 : num! / den!;
  return sar > 1 ? { width: Math.round(width! * sar), height: height! } : sar < 1 ? { width: width!, height: Math.round(height! / sar) } : { width: width!, height: height! };
}

describe("R05 the planned display is FFmpeg's first decoded frame (§4.3, D07)", () => {
  it.each([
    ["crop-lrb.webm", { width: 156, height: 94 }],
    ["crop-rb.mkv", { width: 158, height: 94 }],
    ["clap.mp4", null],
    ["sar43.mp4", { width: 480, height: 240 }],
  ] as const)("R05 %s: P.display is the first decoded frame's size", async (name, stated) => {
    const decoded = await firstFrameDisplay(files.get(name)!);
    if (stated !== null) expect(decoded, "the design's measured size").toEqual(stated);
    const sourceFingerprint = createHash("sha256").update(await readFile(files.get(name)!)).digest("hex");
    const body = presentationRunRequestSchema.parse({
      action: "probe", jobId: "video-presentation-a", sourceFingerprint, deadlineAt: Date.now() + 3_600_000,
      sourceURL: `${SOURCE_BASE}${name}`, limits: PROBE_LIMITS, encoding: ENCODING, probe: PROBE,
    });
    const answer = presentationProbeAnswerSchema.parse(await runOwner.runPresentationProbe(body as Parameters<typeof runOwner.runPresentationProbe>[0])) as unknown as
      { kind: string; plan?: { display: { width: number; height: number } } };
    expect(answer.kind, JSON.stringify(answer)).toBe("planned");
    expect({ width: answer.plan!.display.width, height: answer.plan!.display.height }).toEqual(decoded);
  }, 120_000);
});

/** A grid of 50 slots at 25 fps from 0 for the stitch cases. */
const GRID50 = { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 50, realFrameCount: 50 };
const H264_TARGET = { width: 320, height: 180, displayRect: null, colorMatrix: "bt601", toneMap: "none", alpha: "none", crf: 18, preset: "medium" };
const VP9_TARGET = { ...H264_TARGET, alpha: "straight", format: "webm-vp9" };

/**
 * A stitch of two chunk files over slots [0, 25) and [25, 50) with the source's audio.
 * @param a - The first chunk file.
 * @param b - The second chunk file.
 * @param target - The output target.
 * @returns The job's report and output bytes.
 */
async function stitchOf(a: string, b: string, target: Record<string, unknown>): Promise<Awaited<ReturnType<typeof runJob>>> {
  return runJob({ [SOURCE]: files.get("src.mp4")!, [CHUNK_A]: files.get(a)!, [CHUNK_B]: files.get(b)! }, [{
    recipe: { kind: "stitch", chunks: [{ inputId: CHUNK_A, frames: { start: 0, end: 25 } }, { inputId: CHUNK_B, frames: { start: 25, end: 50 } }],
      inputId: SOURCE, grid: GRID50, audio: target.format !== "webm-vp9", target },
    contentType: target.format === "webm-vp9" ? "video/webm" : "video/mp4",
  }]);
}

describe("R07 a stitch compares its chunks' encode headers (§5.4 拼接 row)", () => {
  it("R07 H.264 chunks with the same SPS and PPS stitch to every slot", async () => {
    const { report, bytes } = await stitchOf("a.mp4", "b.mp4", H264_TARGET);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    const out = join(dir, "stitched.mp4");
    await writeFile(out, bytes[0]!);
    expect(await rawFrames(out, "rgb24")).toHaveLength(50);
  }, 120_000);

  it("R07 H.264 chunks whose PPS differs fail the output and write nothing", async () => {
    const { report, bytes } = await stitchOf("a.mp4", "b-fast.mp4", H264_TARGET);
    expect(report.ok).toBe(false);
    expect(report.outputs ?? []).toEqual([]);
    expect(bytes[0], "no stitched object is written").toBeUndefined();
  }, 120_000);

  it("R07 VP9 chunks with and without an alpha plane fail the output", async () => {
    const control = await stitchOf("va.webm", "vb.webm", VP9_TARGET);
    expect(control.report.ok, `chunks alike stitch: ${JSON.stringify(control.report)}`).toBe(true);
    const { report, bytes } = await stitchOf("va.webm", "vb-opaque.webm", VP9_TARGET);
    expect(report.ok).toBe(false);
    expect(bytes[0]).toBeUndefined();
  }, 120_000);
});

describe("R10 an HLG ProRes source's edit-friendly file is SDR BT.709 (§4.2 HDR row, §4.3 色彩/HDR/位深 row)", () => {
  it("R10 edit_encode tone maps once with the plan's explicit colour inputs and tags the result BT.709", async () => {
    const source = files.get("hlg.mov")!;
    const [mp4] = await produce({ [SOURCE]: source }, [{
      recipe: { kind: "edit_encode", inputId: SOURCE, grid: hlg.grid, source: hlg.source, frames: { start: 0, end: hlg.grid.frameCount },
        edit: { profile: "edit_h264_intra_8bit_420", crf: 0, preset: "ultrafast" },
        color: { matrix: "bt2020nc", transfer: "arib-std-b67", primaries: "bt2020", range: "tv", chromaLocation: "left" }, toneMap: "sdr-bt709" },
      contentType: "video/mp4",
    }]);
    const out = join(dir, "hlg-edit.mp4");
    await writeFile(out, mp4!);
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", out]);
    expect((JSON.parse(stdout) as { streams: Record<string, unknown>[] }).streams[0]).toMatchObject({
      codec_name: "h264", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709",
    });
    const flags = (await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "csv=p=0", out])).stdout.trim().split("\n");
    expect(flags).toHaveLength(hlg.grid.frameCount);
    expect(flags.every((flag) => flag.startsWith("K")), "all-intra").toBe(true);
    // §4.3: the chain with every input given explicitly (zscale names), the same on the whole file.
    const reference = await rawFrames(source, "rgb24",
      "zscale=min=2020_ncl:tin=arib-std-b67:pin=2020:rin=limited:cin=left:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p");
    const produced = await rawFrames(out, "rgb24");
    expect(produced).toHaveLength(reference.length);
    produced.forEach((frame, at) => expect(mad(frame, reference[at]!), `tone-mapped slot ${at}`).toBeLessThanOrEqual(NOISE));
  }, 120_000);
});
