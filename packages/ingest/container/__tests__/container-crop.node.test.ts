// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A Matroska PixelCrop is part of the picture Chromium shows a WebM as, and an MP4 clean aperture is not: the uploaded
 * source's size, its cover and the earlier batches' video tools all take the picture that way. Run on the real ffprobe
 * and ffmpeg 8.0.1, with the production argument lists.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { opSteps } from "@ingest/jobs/op-args.js";
import { pickMediaMetadata, type ProbeReport } from "@ingest/media-metadata.js";
import { coverArgs, probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { runSteps } from "../run-steps.js";
import { writePixelCropped } from "./helpers/matroska-pixel-crop.js";

const run = promisify(execFile);
let dir = "";

/**
 * The probe report the container reads off a local file.
 * @param name - The fixture.
 * @returns The report.
 */
async function probed(name: string): Promise<ProbeReport> {
  return readProbeOutput((await run("ffprobe", probeArgs(join(dir, name), "own-file"))).stdout);
}

/**
 * The size of a video file's first stream as ffmpeg decodes it by default.
 * @param path - The file.
 * @returns The width and height.
 */
async function decodedSize(path: string): Promise<[number, number]> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", path, "-vf", "showinfo", "-frames:v", "1", "-f", "null", "-"]);
  const found = / s:(\d+)x(\d+) /u.exec(stderr);
  expect(found, stderr).not.toBeNull();
  return [Number(found![1]), Number(found![2])];
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "container-crop-"));
  const ff = async (name: string, args: string[]): Promise<void> => {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, join(dir, name)]);
  };
  await ff("whole.mkv", ["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=0.4", "-f", "lavfi", "-i", "sine=d=0.4",
    "-vf", "format=yuv420p,setparams=colorspace=bt709:range=tv", "-c:v", "ffv1", "-c:a", "flac"]);
  await ff("turned.mkv", ["-display_rotation", "90", "-i", join(dir, "whole.mkv"), "-c", "copy"]);
  // Three columns on the left and one row at the top; the turned file shows them at its bottom and its left.
  await writePixelCropped(join(dir, "whole.mkv"), join(dir, "crop.mkv"), { left: 3, top: 1 });
  await writePixelCropped(join(dir, "turned.mkv"), join(dir, "crop-turned.mkv"), { left: 3, top: 1 });
  // The same picture as H.264, which the tools would copy into MP4.
  await ff("whole264.mkv", ["-i", join(dir, "whole.mkv"), "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  await writePixelCropped(join(dir, "whole264.mkv"), join(dir, "crop264.mkv"), { left: 3, top: 1 });
  // FFmpeg writes the PixelCrop into MP4 as a clean aperture, which it reads back and applies on decode.
  await ff("clap.mp4", ["-i", join(dir, "crop.mkv"), "-map", "0:v", "-c", "copy"]);
  await ff("whole.mp4", ["-i", join(dir, "whole.mkv"), "-map", "0:v", "-c", "copy"]);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the size an uploaded source is filed at", () => {
  it.each([
    ["crop.mkv", { width: 157, height: 95 }],
    ["crop-turned.mkv", { width: 95, height: 157 }],
    ["clap.mp4", { width: 160, height: 96 }],
  ])("%s files as %o", async (name, size) => {
    expect(pickMediaMetadata(await probed(name))).toMatchObject(size);
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

  // The crop is made on full-chroma frames, so a cropped cover is the uncropped picture taken to full chroma and cut there;
  // the clean aperture's cover is the cover of the same stream copied into MP4 without it.
  const FULL = "scale=w=iw:h=ih:in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv,format=yuv444p16le";
  it.each([
    ["crop.mkv", `${FULL},crop=157:95:3:1:exact=1`],
    ["crop-turned.mkv", `${FULL},crop=157:95:3:1:exact=1,transpose=cclock`],
    ["clap.mp4", null],
  ])("%s is the picture Chromium shows", async (name, cut) => {
    const got = await cover(name);
    const want = cut === null ? await cover("whole.mp4") : (await run("ffmpeg", ["-v", "error", "-i", join(dir, "whole.mkv"), "-frames:v", "1",
      "-vf", `${cut},scale=in_color_matrix=bt709:in_range=tv,format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout;
    expect(got.length).toBe(want.length);
    expect(got.reduce((sum, value, index) => sum + Math.abs(value - want[index]!), 0) / got.length).toBeLessThan(0.5);
  });
});

describe("the earlier batches' video tools on an uploaded source", () => {
  // The H.264 outputs are taken to even sides; a stream copy would carry the crop as an MP4 clean aperture, which Chromium
  // does not apply, so a cropped source is encoded.
  it.each([
    ["crop", { rect: null }, "crop.mkv", [156, 94]],
    ["audio_denoise", { intensity: 0.5 }, "crop.mkv", [156, 94]],
    ["audio_denoise", { intensity: 0.5 }, "crop264.mkv", [156, 94]],
    ["crop", { rect: null }, "crop264.mkv", [156, 94]],
    ["adjust", { value: {} }, "crop.mkv", [156, 94]],
    ["adjust", { value: {} }, "crop-turned.mkv", [94, 156]],
    ["crop", { rect: { x: 0, y: 0, w: 156, h: 94 } }, "crop.mkv", [156, 94]],
    ["adjust", { value: {} }, "clap.mp4", [160, 96]],
  ] as const)("%s with %o on %s comes out %o", async (op, params, name, size) => {
    const output = join(dir, `${op}-${name}.mp4`);
    await runSteps(opSteps(op, params, join(dir, name), output, dir, await probed(name)));
    expect(await decodedSize(output)).toEqual(size);
    expect(pickMediaMetadata(readProbeOutput((await run("ffprobe", probeArgs(output, "own-file"))).stdout))).toMatchObject({ width: size[0], height: size[1] });
  }, 60_000);

  // FFmpeg's own container crop rounds an offset of 3 to 2 and 1 to 0; the tools crop exactly, then take the sides to even.
  it("adjust on crop.mkv is the picture cropped exactly, not where FFmpeg rounds it", async () => {
    const output = join(dir, "adjust-exact.mp4");
    await runSteps(opSteps("adjust", { value: {} }, join(dir, "crop.mkv"), output, dir, await probed("crop.mkv")));
    const raw = async (path: string, filter: string): Promise<Buffer> =>
      (await run("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-vf", `${filter},format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout;
    const got = await raw(output, "scale=in_color_matrix=bt709:in_range=tv");
    const mean = (want: Buffer): number => got.reduce((sum, value, index) => sum + Math.abs(value - want[index]!), 0) / got.length;
    const full = "scale=w=iw:h=ih:in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv,format=yuv444p16le";
    const exact = mean(await raw(join(dir, "whole.mkv"), `${full},crop=157:95:3:1:exact=1,scale=156:94,scale=in_color_matrix=bt709:in_range=tv`));
    const rounded = mean(await raw(join(dir, "whole.mkv"), `${full},crop=156:94:2:0:exact=1,scale=in_color_matrix=bt709:in_range=tv`));
    expect(exact).toBeLessThan(rounded);
  }, 60_000);
});
