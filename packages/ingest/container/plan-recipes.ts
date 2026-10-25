// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";
import { parseVideoFrameProbe, type VideoFrameProbe } from "@ingest/container/video-frame-probe.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { runAnalysisPipeline } from "@ingest/container/analysis-pipeline.js";
import { readYuNetFaces, readSceneCutObservations } from "@ingest/container/analysis-detection.js";
import { pngSize } from "@ingest/png-size.js";
import { probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pickMediaMetadata } from "@ingest/media-metadata.js";

/** Caller-frozen IO bounds, with no local operational fallback. */
export interface PlanLimits { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number }
/** Complete raw facts of one downloaded immutable input. */
export interface PlanSource { source: VideoFrameProbe; raw: Record<string, unknown> }
/** One recipe's owned local files, raw facts and original lifetime. */
export interface PlanRecipeRequest {
  recipe: MiniToolPlanRecipe;
  input: string;
  output: string;
  directory: string;
  facts: PlanSource;
  signal: AbortSignal;
  limits: PlanLimits;
}

/** JSON metadata artifacts have no image, video duration or optional cover. */
const NO_MEDIA: MediaOfOutput = { width: null, height: null, durationSeconds: null, cover: null };

/**
 * Read a complete raw JSON object without accepting an array or scalar probe.
 * @param bytes - Complete bounded ffprobe stdout.
 * @returns Its raw object.
 * @throws {SyntaxError} When the probe is not valid JSON.
 * @throws {TypeError} When it is not an object.
 */
function probeObject(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Expected a complete ffprobe object");
  return value as Record<string, unknown>;
}

/**
 * Store JSON facts as text without allowing a metadata string to mimic SVG bytes.
 * @param output - The declared local artifact file.
 * @param value - Owned facts, retaining all decoded JSON values.
 * @returns Nothing after the file write.
 * @throws {Error} When encoding or writing fails.
 */
async function writePlanJson(output: string, value: unknown): Promise<void> {
  await writeFile(output, JSON.stringify(value).replace(/</g, "\\u003c"));
}

/**
 * Read complete primary-video frame and all-stream metadata facts.
 * @param input - The downloaded immutable source.
 * @param signal - The original job lifetime.
 * @param limits - Frozen process IO bounds.
 * @returns Raw facts without presentation-clock edits.
 * @throws {Error} When probing, parsing or complete source validation fails.
 */
export async function inspectPlanInput(input: string, signal: AbortSignal, limits: PlanLimits): Promise<PlanSource> {
  const options = { signal, stdoutBytes: limits.probeStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  const base = ["-v", "error", "-protocol_whitelist", "file"];
  const metadata = probeObject(await runPlanCommand("ffprobe", [...base, "-show_streams", "-show_format", "-of", "json", input], options));
  const video = probeObject(await runPlanCommand("ffprobe", [...base, "-select_streams", "v:0", "-show_frames", "-of", "json", input], options));
  const raw = { ...metadata, frames: video.frames };
  return { source: parseVideoFrameProbe(raw), raw };
}

/**
 * Build the exact encoded-geometry raw decoder for selected source ordinals.
 * @param input - The downloaded source.
 * @param selection - An owned FFmpeg frame-selection expression.
 * @returns Direct FFmpeg arguments with no guessed fps or implicit autorotation.
 * @throws {never} Never.
 */
function decoderArgs(input: string, selection: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-noautorotate", "-copyts", "-i", input,
    "-map", "0:v:0", "-vf", selection, "-fps_mode", "passthrough", "-enc_time_base:v", "demux", "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"];
}

/**
 * Execute the pinned separate Python process through the existing BGR owner.
 * @param request - The exact recipe and original lifetime.
 * @param selection - Its frame-selection expression.
 * @param expectedFrameCount - The complete frozen selection size.
 * @returns The complete owned JSON output.
 * @throws {Error} When the detector, complete input or JSON output fails.
 */
async function analyze(request: PlanRecipeRequest, selection: string, expectedFrameCount: number): Promise<Record<string, unknown>> {
  const recipe = request.recipe;
  if (recipe.kind !== "people" && recipe.kind !== "scene_cuts") throw new TypeError("Expected an analysis recipe");
  const { width, height } = request.facts.source;
  const path = join(request.directory, "analysis-request.json");
  await writePlanJson(path, { kind: recipe.kind, width, height, expectedFrameCount, profile: recipe.profile });
  return probeObject(Buffer.from(await runAnalysisPipeline({
    decoder: { program: "ffmpeg", args: decoderArgs(request.input, selection) },
    processor: { program: "python3", args: ["/app/analysis-runtime.py", path] },
    width, height, expectedFrameCount, signal: request.signal,
    limits: { stdoutBytes: request.limits.analysisStdoutBytes, stderrTailBytes: request.limits.stderrTailBytes },
  })));
}

/**
 * Find the positive greatest common divisor without floating-point overflow.
 * @param left - A positive clock integer.
 * @param right - Another positive clock integer.
 * @returns Their greatest common divisor.
 * @throws {never} Never.
 */
function clockGcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

/**
 * Represent actual source clocks exactly in MP4 movie edit-list ticks.
 * @param facts - Complete source facts, including the actual audio sample rate.
 * @returns The smallest exact positive movie timescale accepted by this muxer.
 * @throws {RangeError} When source clocks are unknown or exceed FFmpeg's signed integer domain.
 * @throws {SyntaxError} When the validated source time base is malformed.
 */
function movieTimescale(facts: PlanSource): string {
  const [numeratorText, denominatorText] = facts.source.timeBase.split("/");
  const numerator = BigInt(numeratorText!);
  const denominator = BigInt(denominatorText!);
  if (numerator <= 0n || denominator <= 0n) throw new RangeError("Expected a positive source clock");
  let scale = denominator / clockGcd(numerator, denominator);
  if (facts.source.hasAudio) {
    const rate = readProbeOutput(JSON.stringify({ streams: facts.raw.streams })).streams.find((stream) => stream.codecType === "audio")?.sampleRate;
    if (rate === undefined || !Number.isSafeInteger(rate) || rate <= 0) throw new RangeError("Unknown actual audio sample clock");
    const audioClock = BigInt(rate);
    scale = scale / clockGcd(scale, audioClock) * audioClock;
  }
  // The installed MP4 muxer's movie_timescale option accepts 1..INT_MAX.
  if (scale > 2147483647n) throw new RangeError("Source clocks exceed the exact MP4 movie timescale domain");
  return String(scale);
}

/**
 * Execute one repository-owned recipe against its frozen source clock.
 * @param request - Its input, exact recipe, output and original lifetime.
 * @returns The produced object's actual metadata.
 * @throws {Error} When source identity, media execution or complete output fails.
 */
export async function executePlanRecipe(request: PlanRecipeRequest): Promise<MediaOfOutput> {
  request.signal.throwIfAborted();
  const { recipe, facts, input, output, signal, limits } = request;
  const options = { signal, stdoutBytes: limits.probeStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  switch (recipe.kind) {
    case "inspect_video":
      await writePlanJson(output, { schemaVersion: 1, kind: "inspect_video", source: facts.source, probe: facts.raw });
      return { ...NO_MEDIA };
    case "frame": {
      if (facts.source.frameTable.frames[recipe.frameIndex] === undefined) throw new Error("Frame recipe is outside the complete source ledger");
      await runPlanCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-noautorotate", "-copyts", "-i", input,
        "-map", "0:v:0", "-vf", `select=eq(n\\,${recipe.frameIndex})`, "-fps_mode", "passthrough", "-frames:v", "1", "-c:v", "png", "-f", "image2", output], options);
      const geometry = pngSize(new Uint8Array(await readFile(output)));
      if (geometry === null) throw new Error("Frame recipe did not produce a complete PNG");
      return { width: geometry.width, height: geometry.height, durationSeconds: null, cover: null };
    }
    case "people": {
      const anchor = facts.source.frameTable.frames[recipe.anchor.frameIndex];
      if (anchor === undefined || anchor.pts !== recipe.anchor.pts) throw new Error("Analysis anchor differs from the frozen source ledger");
      const result = await analyze(request, `select=eq(n\\,${recipe.anchor.frameIndex})`, 1);
      const { width, height } = facts.source;
      await writePlanJson(output, { schemaVersion: 1, kind: "people", anchor: recipe.anchor, width, height, candidates: readYuNetFaces(result.faces, { width, height }) });
      return { ...NO_MEDIA };
    }
    case "scene_cuts": {
      const mapping = facts.source.frameTable.frames.filter((frame) => frame.pts >= recipe.range.start && frame.pts < recipe.range.end);
      if (mapping.length === 0) throw new Error("Scene range has no source frames");
      const result = await analyze(request, `select=between(n\\,${mapping[0]!.frameIndex}\\,${mapping[mapping.length - 1]!.frameIndex})`, mapping.length);
      await writePlanJson(output, { schemaVersion: 1, kind: "scene_cuts", timeBase: facts.source.timeBase, frameCount: facts.source.frameTable.frames.length,
        sourceFrameMapping: mapping, cuts: readSceneCutObservations(result.cuts, mapping) });
      return { ...NO_MEDIA };
    }
    case "segment": {
      const start = recipe.range.start;
      const count = facts.source.frameTable.frames.filter((frame) => frame.pts >= start && frame.pts < recipe.range.end).length;
      if (count === 0) throw new Error("Segment range has no source frames");
      // Decode order equals presentation order with B frames disabled. The next
      // actual PTS defines interior display durations; the frozen range boundary
      // defines the last one, rather than a nominal fps or stale packet duration.
      const timing = `setts=pts=PTS:dts=DTS:duration='if(eq(N,${count - 1}),${recipe.range.end - start}/TB-PTS,NEXT_PTS-PTS)'`;
      const timescale = movieTimescale(facts);
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-noautorotate", "-copyts", "-i", input, "-map", "0:v:0",
        "-vf", `trim=start=${start}:end=${recipe.range.end},setpts=PTS-${start}/TB`, "-fps_mode", "passthrough", "-enc_time_base:v", "demux", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-bsf:v", timing];
      if (facts.source.hasAudio && (recipe.audioEnd ?? recipe.range.end) > start) {
        args.push("-map", "0:a:0", "-af", `atrim=start=${start}:end=${recipe.audioEnd ?? recipe.range.end},asetpts=PTS-${start}/TB`, "-c:a", "aac");
      } else args.push("-an");
      args.push("-movie_timescale", timescale, "-movflags", "+faststart", "-f", "mp4", output);
      await runPlanCommand("ffmpeg", args, options);
      const metadata = pickMediaMetadata(readProbeOutput((await runPlanCommand("ffprobe", probeArgs(output, "own-file"), options)).toString("utf8")));
      if (metadata.width === null || metadata.height === null || metadata.durationSeconds === null) throw new Error("Segment recipe produced no complete video metadata");
      return { ...metadata, cover: null };
    }
  }
}
