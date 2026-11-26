// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The picture a source shows is FFmpeg's (frames-split design D07, §4.3): the first frame of its default decode, with a
 * Matroska PixelCrop or an MP4 clean aperture and the display matrix applied, made square by its sample aspect ratio. The
 * uploaded source's size, its cover and the earlier batches' video tools all take that picture, the same one the frame-grid
 * plan's display takes. Run on the real ffprobe and ffmpeg 8.0.1, with the production argument lists.
 */

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { uploadProbeReport, withDecodedDisplay } from "@ingest/container/decoded-display.js";
import { opSteps } from "@ingest/jobs/op-args.js";
import { pickMediaMetadata, type ProbeReport } from "@ingest/media-metadata.js";
import { coverArgs, probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { runSteps } from "../run-steps.js";
import { writePixelCropped } from "./helpers/matroska-pixel-crop.js";

const run = promisify(execFile);
let dir = "";

/**
 * The probe report the container reads off a local source: ffprobe's report with the display of its first decoded frame.
 * @param name - The fixture, or a path.
 * @returns The report.
 */
async function probed(name: string): Promise<ProbeReport> {
  const path = name.startsWith("/") ? name : join(dir, name);
  const report = readProbeOutput((await run("ffprobe", probeArgs(path, "own-file"))).stdout);
  return withDecodedDisplay(report, path, "own-file", async (program, args) =>
    (await run(program, [...args], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout);
}

/**
 * The first frame of a file's default decode as RGB bytes: the container crop runs as FFmpeg's crop filter in the stream's own
 * pixel format (a 4:2:0 crop of left 3, top 1 lands at 2, 0), and the picture is converted after it, through PNG.
 * @param path - The file.
 * @returns The bytes.
 */
async function decodedRgb(path: string): Promise<Buffer> {
  const png = `${path}.first.png`;
  await run("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-vf", "null", "-c:v", "png", png]);
  return (await run("ffmpeg", ["-v", "error", "-i", png, "-vf", "format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout;
}

/**
 * The first frame of a file's default decode, made square by its sample aspect ratio, measured with showinfo.
 * @param path - The file.
 * @returns The width and height.
 */
async function decodedSize(path: string): Promise<[number, number]> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", path, "-map", "0:v:0", "-vf", "showinfo", "-frames:v", "1", "-f", "null", "-"]);
  const line = stderr.split("\n").find((entry) => entry.includes("Parsed_showinfo") && entry.includes(" s:"));
  expect(line, stderr).toBeDefined();
  const [width, height] = / s:(\d+)x(\d+)/u.exec(line!)!.slice(1).map(Number) as [number, number];
  const [num, den] = /sar:(\d+)\/(\d+)/u.exec(line!)!.slice(1).map(Number) as [number, number];
  const sar = num === 0 || den === 0 ? 1 : num / den;
  return sar > 1 ? [Math.round(width * sar), height] : sar < 1 ? [width, Math.round(height / sar)] : [width, height];
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shown-picture-"));
  const ff = async (name: string, args: string[]): Promise<void> => {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, join(dir, name)]);
  };
  await ff("whole.mkv", ["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=0.4", "-f", "lavfi", "-i", "sine=d=0.4",
    "-vf", "format=yuv420p,setparams=colorspace=bt709:range=tv", "-c:v", "ffv1", "-c:a", "flac"]);
  await ff("turned.mkv", ["-display_rotation", "90", "-i", join(dir, "whole.mkv"), "-c", "copy"]);
  // Three columns on the left and one row at the top; the turned file shows them at its bottom and its left.
  await writePixelCropped(join(dir, "whole.mkv"), join(dir, "crop.mkv"), { left: 3, top: 1 });
  await writePixelCropped(join(dir, "turned.mkv"), join(dir, "crop-turned.mkv"), { left: 3, top: 1 });
  // The same picture at 10 bits, with the same crop (the cover depth).
  await ff("whole10.mkv", ["-i", join(dir, "whole.mkv"), "-map", "0:v", "-c:v", "ffv1", "-pix_fmt", "yuv420p10le"]);
  await writePixelCropped(join(dir, "whole10.mkv"), join(dir, "crop10.mkv"), { left: 3, top: 1 });
  // The same picture as H.264, which the tools would copy into MP4.
  await ff("whole264.mkv", ["-i", join(dir, "whole.mkv"), "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  await writePixelCropped(join(dir, "whole264.mkv"), join(dir, "crop264.mkv"), { left: 3, top: 1 });
  // An anamorphic picture: 360x240 stored with SAR 4:3, which Chromium shows at 480x240.
  await ff("sar.mp4", ["-f", "lavfi", "-i", "testsrc2=s=360x240:r=25:d=0.4", "-vf", "setsar=4/3", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p"]);
  // NTSC 4:3 at SAR 8:9, which Chromium shows taller, at 720x540.
  await ff("sar89.mp4", ["-f", "lavfi", "-i", "testsrc2=s=720x480:r=25:d=0.4", "-vf", "setsar=8/9", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  // FFmpeg writes the PixelCrop into MP4 as a clean aperture, which it reads back and applies on decode.
  await ff("clap.mp4", ["-i", join(dir, "crop.mkv"), "-map", "0:v", "-c", "copy"]);
  await ff("whole.mp4", ["-i", join(dir, "whole.mkv"), "-map", "0:v", "-c", "copy"]);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the size an uploaded source is filed at", () => {
  // The container crop takes three columns and one row off 160x96; FFmpeg's decode keeps 4:2:0 sides even.
  it.each([
    ["crop.mkv", { width: 156, height: 94 }],
    ["crop-turned.mkv", { width: 94, height: 156 }],
    ["clap.mp4", null],
    ["sar.mp4", { width: 480, height: 240 }],
    ["sar89.mp4", { width: 720, height: 540 }],
  ])("%s files as the first decoded frame's display %o", async (name, stated) => {
    const [width, height] = await decodedSize(join(dir, name));
    if (stated !== null) expect({ width, height }, "the measured decode").toEqual(stated);
    expect(pickMediaMetadata(await probed(name))).toMatchObject({ width, height });
  });

  // The upload's probe reads the served object over HTTP and decodes through the container's own tool runner.
  it("files a served crop.mkv at 156x94 through the upload probe", async () => {
    const server = createServer((_req, res) => { createReadStream(join(dir, "crop.mkv")).pipe(res); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/crop.mkv`;
      const report = readProbeOutput((await run("ffprobe", probeArgs(url, "object"))).stdout);
      const filed = await uploadProbeReport(report, url, true, new AbortController().signal);
      expect(pickMediaMetadata(filed)).toMatchObject({ width: 156, height: 94 });
    } finally {
      server.close();
    }
  });

  it("logs a failed first-frame decode and files the source at its probed size", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const path = join(dir, "crop.mkv");
      const report = readProbeOutput((await run("ffprobe", probeArgs(path, "own-file"))).stdout);
      const filed = await withDecodedDisplay(report, path, "own-file", async () => { throw new Error("ffmpeg exited 1"); });
      expect(filed).toBe(report);
      expect(logged).toHaveBeenCalledWith("decoded_display_failed", expect.objectContaining({ from: "own-file" }));
    } finally {
      logged.mockRestore();
    }
  });
});

describe("the cover cut from an uploaded source", () => {
  /**
   * The cover the production arguments cut from a fixture, as RGB bytes.
   * @param name - The fixture.
   * @returns The bytes.
   */
  async function cover(name: string): Promise<Buffer> {
    const report = await probed(name);
    const file = join(dir, `${name}.png`);
    const { stdout } = await run("ffmpeg", coverArgs(join(dir, name), "own-file", report),
      { encoding: "buffer", maxBuffer: 1 << 24 });
    await writeFile(file, stdout);
    return (await run("ffmpeg", ["-v", "error", "-i", file, "-vf", "format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout;
  }

  // A cropped stream's cover is its first decoded frame, the container crop applied.
  it.each([["crop.mkv"], ["crop-turned.mkv"], ["clap.mp4"]])("%s is the picture FFmpeg's default decode shows", async (name) => {
    const [got, want] = [await cover(name), await decodedRgb(join(dir, name))];
    expect(got.length).toBe(want.length);
    expect(got.reduce((sum, value, index) => sum + Math.abs(value - want[index]!), 0) / got.length).toBeLessThan(0.5);
  });
});

describe("an anamorphic source", () => {
  /**
   * One frame as RGB bytes.
   * @param path - The file.
   * @param filter - The filters before RGB.
   * @returns The bytes.
   */
  async function rgb(path: string, filter: string): Promise<Buffer> {
    return (await run("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-vf", `${filter},format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout;
  }
  const mean = (a: Buffer, b: Buffer): number => (a.length === b.length ? a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length : Number.POSITIVE_INFINITY);

  it("has a cover of its square-pixel picture, 480x240", async () => {
    const { stdout } = await run("ffmpeg", coverArgs(join(dir, "sar.mp4"), "own-file", await probed("sar.mp4")), { encoding: "buffer", maxBuffer: 1 << 24 });
    const file = join(dir, "sar-cover.png");
    await writeFile(file, stdout);
    expect((await run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file])).stdout.trim()).toBe("480,240");
    // swscale rounds the two conversion orders apart by about one level, differently on arm64 and amd64.
    expect(mean(await rgb(file, "null"), await rgb(join(dir, "sar.mp4"), "scale=480:240"))).toBeLessThan(3);
  });

  // The panel gives a rectangle in the source's filed size; the right half of 480x240.
  it("crops the rectangle the panel drew on the shown picture, with square pixels", async () => {
    const output = join(dir, "sar-rect.mp4");
    await runSteps(opSteps("crop", { rect: { x: 240, y: 0, w: 240, h: 240 } }, join(dir, "sar.mp4"), output, dir, await probed("sar.mp4")));
    expect((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "csv=p=0", output])).stdout.trim()).toMatch(/^240,240,(1:1|N\/A)$/u);
    const got = await rgb(output, "null");
    expect(mean(got, await rgb(join(dir, "sar.mp4"), "scale=480:240,crop=240:240:240:0"))).toBeLessThan(mean(got, await rgb(join(dir, "sar.mp4"), "crop=240:240:120:0")));
  }, 60_000);

  // The panel's rectangle for the whole of an 8:9 picture is 720x540, its filed size.
  it("crops the whole of a taller-shown picture as the panel drew it", async () => {
    const output = join(dir, "sar89-rect.mp4");
    await runSteps(opSteps("crop", { rect: { x: 0, y: 0, w: 720, h: 540 } }, join(dir, "sar89.mp4"), output, dir, await probed("sar89.mp4")));
    expect((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", output])).stdout.trim()).toBe("720,540");
  }, 60_000);

  it("adjusts into its square-pixel picture, 480x240", async () => {
    const output = join(dir, "sar-adjust.mp4");
    await runSteps(opSteps("adjust", { value: {} }, join(dir, "sar.mp4"), output, dir, await probed("sar.mp4")));
    expect((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "csv=p=0", output])).stdout.trim()).toMatch(/^480,240,(1:1|N\/A)$/u);
  }, 60_000);
});

describe("the depth of a cropped cover", () => {
  // A cover keeps its picture's depth whether or not its container crops it.
  it.each([["whole.mkv", "rgb24"], ["crop.mkv", "rgb24"], ["crop10.mkv", "rgb48be"]])("%s gives a %s cover", async (name, depth) => {
    const { stdout } = await run("ffmpeg", coverArgs(join(dir, name), "own-file", await probed(name)), { encoding: "buffer", maxBuffer: 1 << 24 });
    const file = join(dir, `${name}-depth.png`);
    await writeFile(file, stdout);
    expect((await run("ffprobe", ["-v", "error", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file])).stdout.trim()).toBe(depth);
  });
});

describe("the earlier batches' video tools on an uploaded source", () => {
  // The outputs carry the source's filed picture: an H.264 encode of the cropped frame, or a stream copy of H.264 whose MP4
  // clean aperture FFmpeg applies on decode.
  it.each([
    ["crop", { rect: null }, "crop.mkv"],
    ["audio_denoise", { intensity: 0.5 }, "crop.mkv"],
    ["audio_denoise", { intensity: 0.5 }, "crop264.mkv"],
    ["crop", { rect: null }, "crop264.mkv"],
    ["adjust", { value: {} }, "crop.mkv"],
    ["adjust", { value: {} }, "crop-turned.mkv"],
    ["crop", { rect: { x: 0, y: 0, w: 156, h: 94 } }, "crop.mkv"],
    ["adjust", { value: {} }, "clap.mp4"],
  ] as const)("%s with %o on %s comes out at the source's filed size", async (op, params, name) => {
    const source = await probed(name);
    const filed = pickMediaMetadata(source);
    const output = join(dir, `${op}-${name}.mp4`);
    await runSteps(opSteps(op, params, join(dir, name), output, dir, source));
    expect(await decodedSize(output)).toEqual([filed.width, filed.height]);
    expect(pickMediaMetadata(await probed(output))).toMatchObject({ width: filed.width, height: filed.height });
  }, 60_000);

  // Every H.264 output of the earlier batches is High 4:2:0 8-bit, which every browser plays; a crop to full chroma first
  // leaves the depth and the output format as they were.
  it("crop with a rectangle on crop.mkv writes H.264 High 4:2:0", async () => {
    const output = join(dir, "rect.mp4");
    await runSteps(opSteps("crop", { rect: { x: 1, y: 1, w: 100, h: 60 } }, join(dir, "crop264.mkv"), output, dir, await probed("crop264.mkv")));
    expect((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=profile,pix_fmt", "-of", "csv=p=0", output])).stdout.trim()).toBe("High,yuv420p");
  }, 60_000);

  // The tools see the cropped picture: an adjust of a cropped source is its first decoded frame.
  it("adjust on crop.mkv is the adjust of its decoded picture", async () => {
    const output = join(dir, "adjust-crop.mp4");
    await runSteps(opSteps("adjust", { value: {} }, join(dir, "crop.mkv"), output, dir, await probed("crop.mkv")));
    const raw = async (path: string): Promise<Buffer> =>
      (await run("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout;
    const [got, want] = [await raw(output), await decodedRgb(join(dir, "crop.mkv"))];
    expect(got.length).toBe(want.length);
    expect(got.reduce((sum, value, index) => sum + Math.abs(value - want[index]!), 0) / got.length).toBeLessThan(2);
  }, 60_000);
});
