// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ffmpeg runs one mini-tool container operation makes (inner#888 §8.3).
 *
 * Here rather than in the container's server so the argument lists can be
 * tested without ffmpeg; the server is bundled with it at image build time,
 * the same way it carries the probe's arguments.
 */

import type { ContainerFailure, ContainerOp } from "@shared/mini-tools/types.js";
// The one runtime piece of shared the container needs, taken from its own
// file: the container's bundle is built without shared's dependencies, and
// this file has none.
import { buildAdjustVideoFilter, parseAdjustValue } from "@shared/adjust-value.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

/** The container's run endpoint, which the Durable Object posts a job to. */
export const RUN_PATH = "/run";

/** What every run starts with. */
const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

/** H.264 at the settings the worker's handlers used. */
const H264 = ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"];

/** Lets a player start before the whole file has arrived. */
const FASTSTART = ["-movflags", "+faststart"];

/**
 * Round down to an even number of at least 2, which libx264 needs.
 * @param value - Pixels.
 * @returns The even size.
 */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Express a speed as atempo stages, each within the filter's [0.5, 100].
 * @param rate - The speed.
 * @returns The comma-joined chain, or empty for 1.
 */
function atempoChain(rate: number): string {
  const stages: number[] = [];
  let left = rate;
  while (left < 0.5) {
    stages.push(0.5);
    left /= 0.5;
  }
  while (left > 2) {
    stages.push(2);
    left /= 2;
  }
  if (Math.abs(left - 1) > 1e-9 || stages.length === 0) stages.push(left);
  return stages.map((stage) => `atempo=${stage.toFixed(6)}`).join(",");
}

/**
 * A number param, as the request schema already bounded it.
 * @param params - The op's params.
 * @param key - The param.
 * @returns Its value.
 * @throws {Error} When it is not a number.
 */
function numberOf(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} is not a number`);
  return value;
}

/** HDR transfer characteristics by the panel's choice. */
const TRANSFER = { pq: "smpte2084", hlg: "arib-std-b67" } as const;

/** The operations that work on the source's sound. */
const ON_SOUND: ReadonlySet<ContainerOp> = new Set(["audio_denoise"]);

/**
 * Why a source cannot go through an operation, read off its probe before any
 * run starts: an operation on the sound needs a sound to work on.
 * @param op - The operation.
 * @param probe - The source's probe.
 * @returns The failure to report, or null when the source will do.
 */
export function inputRefusal(op: ContainerOp, probe: ProbeReport): ContainerFailure | null {
  if (ON_SOUND.has(op) && !probe.streams.some((stream) => stream.codecType === "audio")) return "no_audio_track";
  return null;
}

/**
 * The runs one operation makes, in order; the last writes `output`.
 * @param op - The operation.
 * @param params - Its params, as the request schema validated them.
 * @param input - Where ffmpeg reads the source.
 * @param output - The file the last run writes.
 * @param workDir - A directory the runs may write between them.
 * @returns One argument list per ffmpeg run.
 * @throws {Error} When a param the operation needs is missing.
 */
export function opRuns(
  op: ContainerOp,
  params: Record<string, unknown>,
  input: string,
  output: string,
  workDir: string,
): string[][] {
  const head = [...QUIET, "-i", input];
  switch (op) {
    case "crop": {
      const rect = params.rect as { x: number; y: number; w: number; h: number } | null;
      if (rect === null) return [[...head, "-c", "copy", ...FASTSTART, output]];
      const crop = `crop=${even(rect.w)}:${even(rect.h)}:${Math.floor(rect.x)}:${Math.floor(rect.y)}`;
      return [[...head, "-vf", crop, "-c:a", "copy", ...FASTSTART, output]];
    }
    case "speed": {
      const rate = numberOf(params, "rate");
      return [
        [
          ...head,
          "-filter:v",
          `setpts=PTS/${rate.toFixed(6)}`,
          "-filter:a",
          atempoChain(rate),
          ...H264,
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          ...FASTSTART,
          output,
        ],
      ];
    }
    case "cut": {
      const range = params.range as { start: number; end: number };
      return [
        [
          ...QUIET,
          "-ss",
          range.start.toFixed(3),
          "-to",
          range.end.toFixed(3),
          "-i",
          input,
          ...H264,
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          ...FASTSTART,
          output,
        ],
      ];
    }
    case "adjust":
      return [[...head, "-vf", buildAdjustVideoFilter(parseAdjustValue(params.value)), ...H264, "-c:a", "copy", ...FASTSTART, output]];
    case "audio_denoise": {
      // One slider onto afftdn: the noise floor from -80 dB to -40 dB and the
      // reduction from 3 dB to 36 dB as the slider goes from 0 to 100.
      const intensity = numberOf(params, "intensity");
      const nf = -80 + (intensity / 100) * 40;
      const nr = 3 + (intensity / 100) * 33;
      return [
        [...head, "-c:v", "copy", "-af", `afftdn=nf=${nf.toFixed(2)}:nr=${nr.toFixed(2)}`, "-c:a", "aac", "-b:a", "128k", ...FASTSTART, output],
      ];
    }
    case "stabilize": {
      const transforms = `${workDir}/transforms.trf`;
      return [
        [...head, "-vf", `vidstabdetect=shakiness=${numberOf(params, "shakiness")}:result=${transforms}`, "-f", "null", "-"],
        [
          ...head,
          "-vf",
          `vidstabtransform=smoothing=${numberOf(params, "smoothing")}:input=${transforms}`,
          ...H264,
          "-c:a",
          "copy",
          ...FASTSTART,
          output,
        ],
      ];
    }
    case "hdr": {
      const transfer = TRANSFER[params.transfer as keyof typeof TRANSFER];
      if (transfer === undefined) throw new Error("transfer is not pq or hlg");
      // SDR white lands at 203 nits, the reference white BT.2408 places it at.
      const filter =
        "zscale=tin=bt709:pin=bt709:min=bt709:t=linear:npl=203,format=gbrpf32le," +
        `zscale=p=bt2020:t=${transfer}:m=bt2020nc:r=tv,format=yuv420p10le`;
      return [
        [
          ...head,
          "-vf",
          filter,
          "-c:v",
          "libx265",
          "-pix_fmt",
          "yuv420p10le",
          "-x265-params",
          `colorprim=bt2020:transfer=${transfer}:colormatrix=bt2020nc`,
          "-color_primaries",
          "bt2020",
          "-color_trc",
          transfer,
          "-colorspace",
          "bt2020nc",
          "-tag:v",
          "hvc1",
          "-c:a",
          "copy",
          ...FASTSTART,
          output,
        ],
      ];
    }
  }
}
