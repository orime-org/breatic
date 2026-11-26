// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The picture a video source shows (frames-split design D07, §4.3): the first frame of FFmpeg's default decode, with a
 * Matroska PixelCrop or an MP4 clean aperture and the display matrix applied, made square by its sample aspect ratio
 * (`squareDisplay`). The frame-grid plan's display and the size an upload is filed at are both read here.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTool } from "@ingest/container/run-tool.js";
import { realVideoStream, squareDisplay, type ProbeReport } from "@ingest/media-metadata.js";
import { PROBE_MAX_BYTES, protocolsFor, type ReadFrom } from "@ingest/probe-command.js";

/** Runs one program and answers its stdout; null, or a throw, when it failed. */
export type CommandRun = (program: string, args: readonly string[]) => Promise<Buffer | null>;

/**
 * Decode the first frames of one video stream with FFmpeg's default decode into a NUT sample, and read the sample's video
 * stream back (ffprobe reports HEVC with an alpha layer as opaque, so the decoded sample is what tells its format).
 * @param run - Runs ffmpeg and ffprobe.
 * @param input - The source.
 * @param protocols - The protocols ffmpeg may read the source through.
 * @param streamIndex - The video stream.
 * @param frames - How many frames to decode.
 * @param sample - The NUT file to write.
 * @returns The decoded stream's ffprobe fields, or null when a command failed or the sample has no video.
 * @throws {Error} When `run` throws.
 */
export async function decodedSample(run: CommandRun, input: string, protocols: string, streamIndex: number, frames: number,
  sample: string): Promise<Record<string, unknown> | null> {
  const made = await run("ffmpeg", ["-v", "error", "-nostdin", "-y", "-protocol_whitelist", protocols, "-i", input, "-map", `0:${String(streamIndex)}`,
    "-frames:v", String(frames), "-c:v", "rawvideo", "-f", "nut", sample]);
  if (made === null) return null;
  const read = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_streams", "-of", "json", sample]);
  if (read === null) return null;
  const streams = (JSON.parse(read.toString("utf8")) as { streams?: unknown }).streams;
  const video = Array.isArray(streams)
    ? streams.find((stream): stream is Record<string, unknown> => typeof stream === "object" && stream !== null && (stream as Record<string, unknown>).codec_type === "video")
    : undefined;
  return video ?? null;
}

/**
 * The square-pixel display of a decoded sample's frame.
 * @param decoded - The decoded stream's ffprobe fields.
 * @returns The display width and height.
 * @throws {TypeError} When the decoded size is not positive.
 */
export function decodedDisplay(decoded: Record<string, unknown>): { width: number; height: number } {
  return squareDisplay({ width: Number(decoded.width), height: Number(decoded.height),
    sar: typeof decoded.sample_aspect_ratio === "string" ? decoded.sample_aspect_ratio : undefined });
}

/**
 * A source's probe with the display of its real video stream's first decoded frame; the probe as it was when the source has
 * no real video stream or the decode fails.
 * @param report - The source's ffprobe report.
 * @param input - The source.
 * @param from - Whether the source is the served object or a local file.
 * @param run - Runs ffmpeg and ffprobe.
 * @returns The report, with `display` when one was decoded.
 * @throws {Error} When the sample's directory cannot be made or removed.
 */
export async function withDecodedDisplay(report: ProbeReport, input: string, from: ReadFrom, run: CommandRun): Promise<ProbeReport> {
  const video = realVideoStream(report);
  if (video === undefined) return report;
  const directory = await mkdtemp(join(tmpdir(), "decoded-display-"));
  try {
    const decoded = await decodedSample(run, input, protocolsFor(from), video.index, 1, join(directory, "sample.nut"));
    return decoded === null ? report : { ...report, display: decodedDisplay(decoded) };
  } catch (err) {
    console.error("decoded_display_failed", { from, err: err instanceof Error ? err.message : String(err) });
    return report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The report an uploaded object is filed by: a video, whose cover is wanted, takes its first decoded frame's display
 * (frames-split D07), which its cover is then scaled to.
 * @param read - ffprobe's report on the served object.
 * @param objectUrl - Where the object is served.
 * @param wantCover - Whether the stored bytes are a video, whose frame the caller wants.
 * @param signal - The run's deadline.
 * @returns The report to file the object by.
 * @throws {Error} When the sample's directory cannot be made or removed.
 */
export async function uploadProbeReport(read: ProbeReport, objectUrl: string, wantCover: boolean, signal: AbortSignal): Promise<ProbeReport> {
  if (!wantCover) return read;
  // FFmpeg's answer is the sample file it writes, so its empty stdout is the answer; ffprobe's answer is its stdout.
  return withDecodedDisplay(read, objectUrl, "object",
    (program, args) => runTool(program, [...args], { maxBytes: PROBE_MAX_BYTES, signal, writesFile: program === "ffmpeg" }));
}
