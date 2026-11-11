// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The ffmpeg and sox steps one mini-tool container operation makes
 * (inner#888 §8.3, inner#1305).
 *
 * Here rather than in the container's server so the argument lists can be
 * tested without ffmpeg; the server is bundled with it at image build time,
 * the same way it carries the probe's arguments.
 */

import type { ContainerFailure, ContainerOp } from "@shared/mini-tools/types.js";
// The runtime pieces of shared the container needs, each taken from its own
// file: the container's bundle is built without shared's dependencies, and
// these files have none.
import { buildAdjustVideoFilter, parseAdjustValue } from "@shared/adjust-value.js";
import { DENOISE_NOISE_FLOOR_DB, denoiseReductionDb } from "@shared/audio-denoise.js";
import { buildCompressorFilter, type DynamicsValue } from "@shared/audio-dynamics.js";
import { PEAK_LIMITER, buildEqFilter } from "@shared/audio-eq.js";
import { pickMediaMetadata, realVideoStream, type ProbeReport } from "@ingest/media-metadata.js";

/** The container's run endpoint, which the Durable Object posts a job to. */
export const RUN_PATH = "/run";

/** What every run starts with. */
const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

/** H.264 at the settings the worker's handlers used. */
const H264 = ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"];

/** AAC at the settings the worker's handlers used. */
const AAC = ["-c:a", "aac", "-b:a", "128k"];

// The output is an .mp4 a browser opens. A stream is copied only when that file
// carries it and Chrome and Safari both play it there; ProRes and VP8 do not
// go into an mp4, and Vorbis or PCM in one plays without sound in Safari.
const MP4_VIDEO: ReadonlySet<string> = new Set(["h264", "hevc", "av1", "vp9"]);
const MP4_AUDIO: ReadonlySet<string> = new Set(["aac", "mp3", "opus"]);

/** Lets a player start before the whole file has arrived. */
const FASTSTART = ["-movflags", "+faststart"];

/**
 * The source is the copy the container downloaded before any run, so ffmpeg
 * opens that one local file and no other protocol.
 */
const SOURCE = ["-protocol_whitelist", "file"];

/**
 * An odd-sized source is legal, and the encoders, vidstab and zscale all need
 * even sides; every chain that re-encodes starts here.
 */
const EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

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

// The names ffprobe writes that zscale also accepts, checked against the
// image's ffmpeg; anything else, or no tag, is read as BT.709.
const ZSCALE_TRANSFERS: ReadonlySet<string> = new Set([
  "bt709", "smpte170m", "bt470bg", "arib-std-b67", "smpte2084", "bt2020-10", "bt2020-12", "iec61966-2-1", "linear",
]);
const ZSCALE_PRIMARIES: ReadonlySet<string> = new Set(["bt709", "smpte170m", "bt470bg", "bt470m", "bt2020", "smpte240m"]);
const ZSCALE_MATRICES: ReadonlySet<string> = new Set(["bt709", "smpte170m", "bt470bg", "bt2020nc", "bt2020c", "smpte240m"]);

/**
 * A colour tag zscale can read, or BT.709 for a missing or unknown one.
 * @param tag - What the probe found.
 * @param known - The names zscale accepts for this tag.
 * @returns The name to hand zscale.
 */
function zscaleName(tag: string | undefined, known: ReadonlySet<string>): string {
  return tag !== undefined && known.has(tag) ? tag : "bt709";
}

/**
 * The HDR filter: into linear light as the source's own tags describe it, then
 * out to BT.2020 at the chosen transfer.
 * @param transfer - The output transfer.
 * @param source - The source's probe.
 * @returns The filter chain.
 */
function hdrFilter(transfer: string, source: ProbeReport): string {
  const video = realVideoStream(source);
  const tin = zscaleName(video?.colorTransfer, ZSCALE_TRANSFERS);
  const pin = zscaleName(video?.colorPrimaries, ZSCALE_PRIMARIES);
  const min = zscaleName(video?.colorSpace, ZSCALE_MATRICES);
  // SDR white lands at 203 nits, the reference white BT.2408 places it at;
  // zimg reads the peak on the step that writes the HDR transfer. The linear
  // step names its output primaries: with them unknown zimg finds no path.
  return (
    `${EVEN},zscale=tin=${tin}:pin=${pin}:min=${min}:t=linear:npl=203:p=bt709,format=gbrpf32le,` +
    `zscale=p=bt2020:t=${transfer}:m=bt2020nc:r=tv:npl=203,format=yuv420p10le`
  );
}

/**
 * The source's picture into the output: copied when an mp4 plays it as it is,
 * otherwise encoded as H.264 on even sides.
 * @param source - The source's probe.
 * @returns The video arguments.
 */
function videoOut(source: ProbeReport): string[] {
  const codec = realVideoStream(source)?.codecName ?? "";
  if (!MP4_VIDEO.has(codec)) return ["-vf", EVEN, ...H264];
  // An HEVC stream copied into mp4 is tagged hev1 by default, which Safari does not open.
  return codec === "hevc" ? ["-c:v", "copy", "-tag:v", "hvc1"] : ["-c:v", "copy"];
}

/**
 * The source's sound into the output: copied when an mp4 plays it as it is,
 * otherwise encoded as AAC.
 * @param source - The source's probe.
 * @returns The audio arguments.
 */
function audioOut(source: ProbeReport): string[] {
  const audio = source.streams.find((stream) => stream.codecType === "audio");
  return audio === undefined || MP4_AUDIO.has(audio.codecName ?? "") ? ["-c:a", "copy"] : AAC;
}

/** An operation on an audio source that writes audio (inner#1305). */
type AudioOp = "denoise" | "normalize" | "audio_speed" | "audio_cut" | "eq" | "compress" | "pan" | "reverb" | "voice" | "pitch";

/** The operations that read further clips after the source (inner#1825 §6.4). */
type JoinOp = "join" | "audio_join";

/** An operation on a video source that writes video, one input in. */
export type VideoOp = Exclude<ContainerOp, AudioOp | JoinOp>;

/** The operations whose source is an audio file and whose result is one (inner#1305). */
const AUDIO_OPS: ReadonlySet<ContainerOp> = new Set<AudioOp>([
  "denoise",
  "normalize",
  "audio_speed",
  "audio_cut",
  "eq",
  "compress",
  "pan",
  "reverb",
  "voice",
  "pitch",
]);

/** The operations that work on the source's sound. */
const ON_SOUND: ReadonlySet<ContainerOp> = new Set(["audio_denoise", ...AUDIO_OPS]);

/**
 * What an operation writes.
 * @param op - The operation.
 * @returns `audio` for the audio operations and the audio join, `video` for the rest.
 */
export function mediumOf(op: ContainerOp): "audio" | "video" {
  return AUDIO_OPS.has(op) || op === "audio_join" ? "audio" : "video";
}

/**
 * The name of the file an operation writes; its extension picks the muxer,
 * and `.m4a` is the one that brands the file as audio.
 * @param op - The operation.
 * @returns The file name.
 */
export function outputFileName(op: ContainerOp): string {
  return mediumOf(op) === "audio" ? "out.m4a" : "out.mp4";
}

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
 * Why a clip cannot go into a join, read off its probe before any run starts
 * (inner#1825 §6.4): a video join needs a picture in every clip, an audio join
 * a sound in every clip.
 * @param op - The operation.
 * @param probe - The clip's probe.
 * @returns The failure to report, or null when the clip will do or the operation joins nothing.
 */
export function clipRefusal(op: ContainerOp, probe: ProbeReport): ContainerFailure | null {
  if (op === "join") return realVideoStream(probe) === undefined ? "tool_failed" : null;
  if (op === "audio_join") return probe.streams.some((stream) => stream.codecType === "audio") ? null : "tool_failed";
  return null;
}

/**
 * The run that reads a whole file through to learn how long it plays, for a
 * clip whose container states no length (a browser recorder's WebM): its
 * progress, written to stdout, ends on the time it reached.
 * @param file - The local file.
 * @returns The ffmpeg arguments.
 */
export function lengthArgs(file: string): string[] {
  return ["-v", "error", "-nostats", "-i", file, "-map", "0", "-f", "null", "-progress", "pipe:1", "-"];
}

/**
 * The length a run of {@link lengthArgs} reached: the last time its progress reports.
 * @param progress - What the run wrote to stdout.
 * @returns The seconds, or null when it reported none.
 */
export function readProgressLength(progress: string): number | null {
  const times = [...progress.matchAll(/^out_time_us=(\d+)$/gm)].map((match) => Number(match[1]));
  const last = times[times.length - 1];
  return last === undefined || !(last > 0) ? null : last / 1_000_000;
}

/**
 * Why a finished output cannot be filed: a video operation keeps the picture,
 * so one without a video stream (a cut inside a sound-only tail) failed; an
 * audio operation's output must carry sound.
 * @param probe - The output's probe.
 * @param medium - What the operation writes.
 * @returns The failure to report, or null when the output will do.
 */
export function outputRefusal(probe: ProbeReport, medium: "audio" | "video"): ContainerFailure | null {
  if (medium === "audio") return probe.streams.some((stream) => stream.codecType === "audio") ? null : "tool_failed";
  return realVideoStream(probe) === undefined ? "tool_failed" : null;
}

/**
 * The runs one operation makes, in order; the last writes `output`.
 * @param op - The operation.
 * @param params - Its params, as the request schema validated them.
 * @param input - The local copy of the source.
 * @param output - The file the last run writes.
 * @param workDir - A directory the runs may write between them.
 * @param source - The source's probe: which streams are copied, and the colour tags HDR reads.
 * @returns One argument list per ffmpeg run.
 * @throws {Error} When a param the operation needs is missing.
 */
export function opRuns(
  op: VideoOp,
  params: Record<string, unknown>,
  input: string,
  output: string,
  workDir: string,
  source: ProbeReport,
): string[][] {
  const head = [...QUIET, ...SOURCE, "-i", input];
  switch (op) {
    case "crop": {
      const rect = params.rect as { x: number; y: number; w: number; h: number } | null;
      if (rect === null) return [[...head, ...videoOut(source), ...audioOut(source), ...FASTSTART, output]];
      const crop = `crop=${even(rect.w)}:${even(rect.h)}:${Math.floor(rect.x)}:${Math.floor(rect.y)}`;
      return [[...head, "-vf", crop, ...audioOut(source), ...FASTSTART, output]];
    }
    case "speed": {
      const rate = numberOf(params, "rate");
      return [
        [
          ...head,
          "-filter:v",
          `${EVEN},setpts=PTS/${rate.toFixed(6)}`,
          "-filter:a",
          atempoChain(rate),
          ...H264,
          ...AAC,
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
          ...SOURCE,
          "-i",
          input,
          "-vf",
          EVEN,
          ...H264,
          ...AAC,
          ...FASTSTART,
          output,
        ],
      ];
    }
    case "adjust":
      return [[...head, "-vf", `${EVEN},${buildAdjustVideoFilter(parseAdjustValue(params.value))}`, ...H264, ...audioOut(source), ...FASTSTART, output]];
    case "audio_denoise":
      return [[...head, ...videoOut(source), "-af", denoiseFilter(numberOf(params, "intensity")), ...AAC, ...FASTSTART, output]];
    case "stabilize": {
      const transforms = `${workDir}/transforms.trf`;
      return [
        [...head, "-vf", `${EVEN},vidstabdetect=shakiness=${numberOf(params, "shakiness")}:result=${transforms}`, "-f", "null", "-"],
        [
          ...head,
          "-vf",
          `${EVEN},vidstabtransform=smoothing=${numberOf(params, "smoothing")}:input=${transforms}`,
          ...H264,
          ...audioOut(source),
          ...FASTSTART,
          output,
        ],
      ];
    }
    case "hdr": {
      const transfer = TRANSFER[params.transfer as keyof typeof TRANSFER];
      if (transfer === undefined) throw new Error("transfer is not pq or hlg");
      const filter = hdrFilter(transfer, source);
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
          ...audioOut(source),
          ...FASTSTART,
          output,
        ],
      ];
    }
  }
}

/**
 * One slider onto afftdn, the same for a video's sound and an audio file: the
 * slider sets how far the noise comes down (`denoiseReductionDb`), and the
 * noise floor stays where common noise sits (`DENOISE_NOISE_FLOOR_DB`).
 * @param intensity - The slider.
 * @returns The filter.
 */
function denoiseFilter(intensity: number): string {
  return `afftdn=nf=${DENOISE_NOISE_FLOOR_DB}:nr=${denoiseReductionDb(intensity).toFixed(2)}`;
}

/** One program and its arguments. */
export interface Command {
  readonly program: "ffmpeg" | "sox";
  readonly args: string[];
}

/**
 * One step of an operation, run after the one before it finishes: a single
 * command; commands joined stdout to stdin with no file between them; or a
 * measuring run whose stderr decides the steps after it.
 */
export type RunStep =
  | ({ readonly kind: "run" } & Command)
  | { readonly kind: "pipe"; readonly commands: Command[] }
  | ({ readonly kind: "measure"; readonly then: (stderr: string) => RunStep[] } & Command);

/** AAC into an .m4a a player can start before it has the whole file. */
const AUDIO_OUT = ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];

/**
 * The source's audio stream's sample rate.
 * @param source - The source's probe.
 * @returns Hertz, or null when the probe read none.
 */
function sampleRateOf(source: ProbeReport): number | null {
  return source.streams.find((stream) => stream.codecType === "audio")?.sampleRate ?? null;
}

/**
 * Float samples for a chain: a filter that negotiates 16-bit samples (the
 * equaliser does) clips a gain past full scale itself, before the limiter at
 * the end of the chain can hold it, and AAC then overshoots the clipped wave.
 */
const FLOAT = "aformat=sample_fmts=fltp";

/**
 * One run from the source to the output, through a filter when one is given.
 * @param input - The local source.
 * @param output - The file to write.
 * @param filter - The `-af` chain, or null to re-encode untouched.
 * @param before - Options before the input, such as a cut's range.
 * @returns The step.
 */
function audioRun(input: string, output: string, filter: string | null, before: string[] = []): RunStep {
  return {
    kind: "run",
    program: "ffmpeg",
    args: [...QUIET, ...before, ...SOURCE, "-i", input, "-vn", ...(filter === null ? [] : ["-af", `${FLOAT},${filter}`]), ...AUDIO_OUT, output],
  };
}

/**
 * The source decoded to WAV on stdout, for sox to read.
 * @param input - The local source.
 * @returns The command.
 */
function decodeToPipe(input: string): Command {
  return { program: "ffmpeg", args: [...QUIET, ...SOURCE, "-i", input, "-vn", "-f", "wav", "-"] };
}

/** What loudnorm's first pass measured, as it printed it. */
export interface LoudnormMeasure {
  inputI: string;
  inputTp: string;
  inputLra: string;
  inputThresh: string;
  targetOffset: string;
}

/**
 * The measurement loudnorm printed last on stderr.
 * @param stderr - The first pass's stderr, at info level.
 * @returns The measurement, or null when none can be read.
 */
export function readLoudnormMeasure(stderr: string): LoudnormMeasure | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const fields = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
  if (!fields.every((field) => typeof parsed[field] === "string")) return null;
  return {
    inputI: parsed.input_i as string,
    inputTp: parsed.input_tp as string,
    inputLra: parsed.input_lra as string,
    inputThresh: parsed.input_thresh as string,
    targetOffset: parsed.target_offset as string,
  };
}

/**
 * Loudness in two passes: measure, then apply the measurement linearly, and
 * resample back by filter, which lets the encoder fall back from a rate AAC
 * does not take (loudnorm works at 192 kHz).
 * @param target - The integrated loudness, in LUFS.
 * @param input - The local source.
 * @param output - The file to write.
 * @param rate - The source's rate, null when unknown.
 * @returns The measuring step.
 */
function normalizeSteps(target: string, input: string, output: string, rate: number | null): RunStep[] {
  const goal = `loudnorm=I=${target}:TP=-1:LRA=11`;
  const resample = rate === null ? [] : [`aresample=${rate}`];
  return [
    {
      kind: "measure",
      program: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "info", "-y", ...SOURCE, "-i", input, "-vn", "-af", `${goal}:print_format=json`, "-f", "null", "-"],
      then: (stderr) => {
        const measured = readLoudnormMeasure(stderr);
        if (measured === null) throw new Error("loudnorm printed no measurement");
        // A silent source measures -inf; there is nothing to bring up.
        const silent = measured.inputI === "-inf" || measured.inputTp === "-inf";
        const applied = silent
          ? resample
          : [
              `${goal}:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}:measured_LRA=${measured.inputLra}` +
                `:measured_thresh=${measured.inputThresh}:offset=${measured.targetOffset}:linear=true`,
              ...resample,
            ];
        return [audioRun(input, output, applied.length === 0 ? null : applied.join(","))];
      },
    },
  ];
}

/** A reverb room in sox's terms, from Audacity's factory presets of the same name. */
interface Room {
  reverberance: number;
  damping: number;
  size: number;
  stereo: number;
  preDelay: number;
  wetGain: number;
}

// audacity/audacity src/effects/builtin_collection/reverb/reverbeffect.cpp,
// FactoryPresets, room-size rows; the dry gain is ours (always the source).
const ROOMS: Readonly<Record<string, Room>> = {
  small_room: { reverberance: 50, damping: 50, size: 30, stereo: 100, preDelay: 10, wetGain: -1 },
  medium_room: { reverberance: 40, damping: 50, size: 75, stereo: 70, preDelay: 10, wetGain: -1 },
  large_room: { reverberance: 40, damping: 50, size: 85, stereo: 90, preDelay: 10, wetGain: 0 },
  church_hall: { reverberance: 60, damping: 50, size: 90, stereo: 100, preDelay: 32, wetGain: 0 },
  cathedral: { reverberance: 90, damping: 50, size: 90, stereo: 100, preDelay: 16, wetGain: 0 },
  bathroom: { reverberance: 80, damping: 0, size: 16, stereo: 100, preDelay: 8, wetGain: -6 },
};

/**
 * The room the source is played in: sox writes the wet sound with a tail,
 * and ffmpeg adds it to the untouched source at the amount's level.
 * @param params - The room and the amount.
 * @param input - The local source.
 * @param output - The file to write.
 * @returns The steps.
 * @throws {Error} When the room is not one of the six.
 */
function reverbSteps(params: Record<string, unknown>, input: string, output: string): RunStep[] {
  const amount = numberOf(params, "amount");
  if (amount === 0) return [audioRun(input, output, null)];
  const room = ROOMS[String(params.room)];
  if (room === undefined) throw new Error("room is not one of the presets");
  const wet = Math.min(10, Math.max(-10, room.wetGain));
  const tail = room.reverberance <= 50 ? 2 : 4;
  const level = (20 * Math.log10(amount / 50)).toFixed(2);
  return [
    {
      kind: "pipe",
      commands: [
        decodeToPipe(input),
        {
          program: "sox",
          args: [
            "-t", "wav", "-", "-t", "wav", "-",
            "pad", "0", String(tail),
            "reverb", "-w",
            String(room.reverberance), String(room.damping), String(room.size),
            String(room.stereo), String(room.preDelay), String(wet),
          ],
        },
        {
          program: "ffmpeg",
          args: [
            ...QUIET, ...SOURCE, "-i", input, "-f", "wav", "-i", "-",
            "-filter_complex", `[1]volume=${level}dB[w];[0][w]amix=inputs=2:normalize=0:duration=longest,${PEAK_LIMITER}`,
            "-vn", ...AUDIO_OUT, output,
          ],
        },
      ],
    },
  ];
}

/**
 * The steps one operation on an audio source makes, the last writing `output`.
 * @param op - The operation.
 * @param params - Its params, as the request schema validated them.
 * @param input - The local copy of the source.
 * @param output - The file the last step writes.
 * @param source - The source's probe.
 * @returns The steps.
 * @throws {Error} When a param the operation needs is missing, or the speed
 *   must let the pitch follow and the source's rate is not known.
 */
function audioSteps(op: AudioOp, params: Record<string, unknown>, input: string, output: string, source: ProbeReport): RunStep[] {
  const rate = sampleRateOf(source);
  switch (op) {
    case "denoise":
      return [audioRun(input, output, denoiseFilter(numberOf(params, "intensity")))];
    case "normalize":
      return normalizeSteps(String(params.target), input, output, rate);
    case "audio_speed": {
      const speed = numberOf(params, "rate");
      if (params.keepPitch !== false) return [audioRun(input, output, atempoChain(speed))];
      if (rate === null) throw new Error("the source's sample rate is unknown");
      return [audioRun(input, output, `asetrate=${Math.round(rate * speed)},aresample=${rate}`)];
    }
    case "audio_cut": {
      const range = params.range as { start: number; end: number };
      return [audioRun(input, output, null, ["-ss", range.start.toFixed(3), "-to", range.end.toFixed(3)])];
    }
    case "eq":
      return [audioRun(input, output, buildEqFilter((params.eq as { gains: number[] }).gains, rate))];
    case "compress":
      return [audioRun(input, output, `${buildCompressorFilter(params.dynamics as DynamicsValue)},${PEAK_LIMITER}`)];
    case "pan": {
      const width = (numberOf(params, "width") / 100).toFixed(2);
      const balance = (numberOf(params, "pan") / 100).toFixed(2);
      return [
        audioRun(
          input,
          output,
          `aformat=channel_layouts=stereo,extrastereo=m=${width}:c=0,stereotools=balance_out=${balance},${PEAK_LIMITER}`,
        ),
      ];
    }
    case "reverb":
      return reverbSteps(params, input, output);
    case "voice": {
      const strength = numberOf(params, "intensity") / 100;
      if (strength === 0) return [audioRun(input, output, null)];
      return [
        audioRun(
          input,
          output,
          `highpass=f=80,equalizer=f=3000:t=q:w=1:g=${(6 * strength).toFixed(2)},deesser=i=${(0.5 * strength).toFixed(2)}` +
            `,acompressor=threshold=0.1:ratio=${(1 + 2 * strength).toFixed(2)}:attack=10:release=150,${PEAK_LIMITER}`,
        ),
      ];
    }
    case "pitch": {
      const cents = 100 * numberOf(params, "semitones") + numberOf(params, "cents");
      if (cents === 0) return [audioRun(input, output, null)];
      return [
        {
          kind: "pipe",
          commands: [
            decodeToPipe(input),
            { program: "sox", args: ["-t", "wav", "-", "-t", "wav", "-", "pitch", String(cents)] },
            { program: "ffmpeg", args: [...QUIET, "-f", "wav", "-i", "-", ...AUDIO_OUT, output] },
          ],
        },
      ];
    }
  }
}

/** One input after the source, as the container downloaded and probed it. */
export interface ExtraInput {
  readonly path: string;
  readonly probe: ProbeReport;
}

/** The rate and layout a video join writes its sound at. */
const JOIN_VIDEO_SOUND = "sample_rates=48000:channel_layouts=stereo";

/**
 * A length in seconds as a filter option takes it, to the millisecond.
 * @param value - Seconds.
 * @returns The text.
 */
function seconds(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * A clip's probed length, which a crossfade's offset and a silent track need.
 * @param probe - The clip's probe.
 * @returns Seconds.
 * @throws {Error} When the probe read no length.
 */
function lengthOf(probe: ProbeReport): number {
  const length = probe.durationSeconds;
  if (length === null || !(length > 0)) throw new Error("a clip's length is unknown");
  return length;
}

/**
 * Each neighbour pair's crossfade: the one asked for, held to half the
 * shorter of the two clips, so no fade reaches past a clip's middle.
 * @param crossfade - The seconds asked for.
 * @param lengths - Every clip's length, in joining order.
 * @returns One fade per pair, in order.
 */
function fadesOf(crossfade: number, lengths: readonly number[]): number[] {
  return lengths.slice(1).map((length, i) => Math.min(crossfade, Math.min(lengths[i]!, length) / 2));
}

/**
 * The labelled streams joined end to end: one concat when there is no
 * crossfade, otherwise each fused into the next with the filter given.
 * @param labels - Each clip's stream label, in joining order.
 * @param fades - Each neighbour pair's crossfade, empty for a plain concat.
 * @param fuse - The filter that fades a pair, given its fade and the pair's index.
 * @param out - The output label.
 * @returns The graph's chains.
 */
function chainOf(labels: readonly string[], fades: readonly number[], fuse: (fade: number, i: number) => string, out: string): string[] {
  const chains: string[] = [];
  let last = labels[0]!;
  for (let i = 1; i < labels.length; i++) {
    const next = i === labels.length - 1 ? out : `x${out}${i}`;
    chains.push(`[${last}][${labels[i]}]${fuse(fades[i - 1]!, i)}[${next}]`);
    last = next;
  }
  return chains;
}

/**
 * The run that joins video clips: every clip fitted inside the first one's
 * frame, centred, at its frame rate, with a sound track of its own length
 * (silence for a clip without one), then concatenated or crossfaded.
 * @param params - The crossfade, in seconds.
 * @param clips - Every clip, the source first.
 * @param output - The file to write.
 * @returns The step.
 * @throws {Error} When the first clip's frame is unknown, or a length a step needs is unknown.
 */
function joinVideoSteps(params: Record<string, unknown>, clips: readonly ExtraInput[], output: string): RunStep[] {
  const first = pickMediaMetadata(clips[0]!.probe);
  if (first.width === null || first.height === null) throw new Error("the first clip's frame is unknown");
  const w = even(first.width);
  const h = even(first.height);
  // ponytail: a first clip whose rate ffprobe could not read is written at 30.
  const fps = Math.round((realVideoStream(clips[0]!.probe)?.frameRate ?? 30) * 1_000_000) / 1_000_000;
  const crossfade = numberOf(params, "crossfade");
  const graph: string[] = [];
  clips.forEach((clip, i) => {
    const length = seconds(lengthOf(clip.probe));
    // The picture is held on its last frame, then cut, to the clip's length,
    // the same length its sound is padded or cut to below, so the crossfade
    // offsets read off that length meet both streams where they end.
    graph.push(
      `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
        `setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS,` +
        `tpad=stop_mode=clone:stop_duration=${length},trim=duration=${length}[v${i}]`,
    );
    const sounded = clip.probe.streams.some((stream) => stream.codecType === "audio");
    graph.push(
      sounded
        ? `[${i}:a:0]aformat=${JOIN_VIDEO_SOUND},asetpts=PTS-STARTPTS,apad,atrim=duration=${length}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${length}[a${i}]`,
    );
  });
  const video = clips.map((_, i) => `v${i}`);
  const sound = clips.map((_, i) => `a${i}`);
  if (crossfade <= 0) {
    graph.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${clips.length}:v=1:a=1[v][a]`);
  } else {
    const lengths = clips.map((clip) => lengthOf(clip.probe));
    const fades = fadesOf(crossfade, lengths);
    // The i-th fade starts where the joined picture so far ends, less this fade.
    let end = lengths[0]!;
    const offsets = fades.map((fade, i) => {
      const offset = end - fade;
      end = offset + lengths[i + 1]!;
      return offset;
    });
    graph.push(...chainOf(video, fades, (fade, i) => `xfade=transition=fade:duration=${seconds(fade)}:offset=${seconds(offsets[i - 1]!)}`, "v"));
    graph.push(...chainOf(sound, fades, (fade) => `acrossfade=d=${seconds(fade)}`, "a"));
  }
  const inputs = clips.flatMap((clip) => [...SOURCE, "-i", clip.path]);
  return [
    {
      kind: "run",
      program: "ffmpeg",
      args: [...QUIET, ...inputs, "-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]", ...H264, ...AAC, ...FASTSTART, output],
    },
  ];
}

/**
 * The run that joins audio clips: each resampled to the first one's rate and
 * channels, then concatenated or crossfaded.
 * @param params - The crossfade, in seconds.
 * @param clips - Every clip, the source first.
 * @param output - The file to write.
 * @returns The step.
 * @throws {Error} When a crossfade is asked for and a clip's length is unknown.
 */
function joinAudioSteps(params: Record<string, unknown>, clips: readonly ExtraInput[], output: string): RunStep[] {
  const firstSound = clips[0]!.probe.streams.find((stream) => stream.codecType === "audio");
  const rate = firstSound?.sampleRate ?? 48000;
  // ponytail: more than two channels are folded to stereo; the probe carries no layout name to keep them by.
  const layout = firstSound?.channels === 1 ? "mono" : "stereo";
  const crossfade = numberOf(params, "crossfade");
  const graph = clips.map(
    (_, i) => `[${i}:a:0]aresample=${rate},aformat=sample_rates=${rate}:channel_layouts=${layout},asetpts=PTS-STARTPTS[a${i}]`,
  );
  const sound = clips.map((_, i) => `a${i}`);
  if (crossfade <= 0) {
    graph.push(`${sound.map((label) => `[${label}]`).join("")}concat=n=${clips.length}:v=0:a=1[a]`);
  } else {
    const fades = fadesOf(crossfade, clips.map((clip) => lengthOf(clip.probe)));
    graph.push(...chainOf(sound, fades, (fade) => `acrossfade=d=${seconds(fade)}`, "a"));
  }
  const inputs = clips.flatMap((clip) => [...SOURCE, "-i", clip.path]);
  return [
    {
      kind: "run",
      program: "ffmpeg",
      args: [...QUIET, ...inputs, "-filter_complex", graph.join(";"), "-map", "[a]", "-vn", ...AUDIO_OUT, output],
    },
  ];
}

/**
 * The steps one operation makes, the last writing `output`: an audio
 * operation's own, or a video operation's runs one after another.
 * @param op - The operation.
 * @param params - Its params, as the request schema validated them.
 * @param input - The local copy of the source.
 * @param output - The file the last step writes.
 * @param workDir - A directory the runs may write between them.
 * @param source - The source's probe.
 * @param extra - The inputs after the source, in order: a join's further clips.
 * @returns The steps.
 * @throws {Error} When a param the operation needs is missing.
 */
export function opSteps(
  op: ContainerOp,
  params: Record<string, unknown>,
  input: string,
  output: string,
  workDir: string,
  source: ProbeReport,
  extra: readonly ExtraInput[] = [],
): RunStep[] {
  if (op === "join" || op === "audio_join") {
    const clips = [{ path: input, probe: source }, ...extra];
    return op === "join" ? joinVideoSteps(params, clips, output) : joinAudioSteps(params, clips, output);
  }
  if (AUDIO_OPS.has(op)) return audioSteps(op as AudioOp, params, input, output, source);
  return opRuns(op as VideoOp, params, input, output, workDir, source).map((args) => ({ kind: "run", program: "ffmpeg", args }));
}
