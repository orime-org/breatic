// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared harness of the frame-grid container tests (inner#1306 test plan §65.3 R01–R10; frames-split design §4.1, §7.16,
 * §7.17). It runs one grid recipe through the planned container job with every input served and every output captured
 * per URL (so cases run concurrently), and it builds the oracle the way the maintainers' frame-grid sample set checks
 * itself: the grid read from the file with ffprobe, then the whole file decoded through the same filter chain the design
 * fixes (`setpts`, `tpad=stop=-1`, `fps`, `trim`), frame by frame.
 *
 * The grid recipe fields are the ones this test batch proposes for the design's §7.17 text ("帧号或帧号区间、fps、网格起点、
 * 补头与保持帧数、工具源对象与解码起点"): `grid` {fps, gridStart, frameCount, realFrameCount} and `source` (the original with
 * its source keyframe statistics, or the edit-friendly file). Exact times are number rationals in seconds, the shape
 * `frame-grid-rate.ts` writes.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, vi } from "vitest";
import { runPlanJob, type PlanRunBody } from "@ingest/container/plan-run.js";
import { miniToolPlanRecipeSchema } from "@shared/upload/mini-tool-plan-job.js";
import type { FrameRate } from "@shared/upload/frame-grid-rate.js";

declare global {
  /**
   * The planned job schema's module reaches shared's HTTP client, which names the DOM `BodyInit`; this Node program has Node's
   * fetch types instead, whose request body is the same union.
   */
  type BodyInit = NonNullable<RequestInit["body"]>;
}

export const run = promisify(execFile);

/** The committed samples of the maintainers' frame-grid sample set. */
export const FIXTURES = fileURLToPath(new URL("../../fixtures/frame-grid/", import.meta.url));

export const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };

export type { FrameRate };
/** An exact time in seconds, in the frame-rate shape. */
export type Exact = FrameRate;
/** The grid of a recipe (§4.1): rate, grid start in source seconds, the slot count and the real video slots. */
export interface GridRef { fps: FrameRate; gridStart: Exact; frameCount: number; realFrameCount: number }
/** Source keyframe statistics (§7.16), in seconds. */
export interface SourceKeyframeStats { earliestKeyframeTime: number; maxKeyframeInterval: number; allKeyframes: boolean }
/** The tool source of a recipe (§7.16): the original with its keyframe statistics, or the edit-friendly file. */
export type ToolSourceRef = { kind: "original"; keyframes: SourceKeyframeStats } | { kind: "edit" };

/** A BigInt rational. */
interface Rational { n: bigint; d: bigint }

/**
 * The greatest common divisor.
 * @param a - One.
 * @param b - The other.
 * @returns It, non-negative.
 */
function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * A reduced rational.
 * @param n - Numerator.
 * @param d - Denominator, non-zero.
 * @returns It.
 */
function rat(n: bigint, d: bigint): Rational {
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d) || 1n;
  return { n: (sign * n) / g, d: (sign * d) / g };
}

/**
 * Subtract.
 * @param a - Minuend.
 * @param b - Subtrahend.
 * @returns a − b.
 */
function sub(a: Rational, b: Rational): Rational { return rat(a.n * b.d - b.n * a.d, a.d * b.d); }

/**
 * Compare.
 * @param a - One.
 * @param b - The other.
 * @returns Negative, zero or positive.
 */
function cmp(a: Rational, b: Rational): number { const v = a.n * b.d - b.n * a.d; return v < 0n ? -1 : v > 0n ? 1 : 0; }

/**
 * Round half away from zero, as the `fps` filter does.
 * @param a - The value.
 * @returns The integer.
 */
function roundNear(a: Rational): number {
  const twice = 2n * a.n + (a.n >= 0n ? a.d : -a.d);
  const q = twice / (2n * a.d);
  return Number(q);
}

/**
 * The ceiling.
 * @param a - The value.
 * @returns The integer.
 */
function ceil(a: Rational): number {
  const q = a.n / a.d;
  return Number(a.n > 0n && a.n % a.d !== 0n ? q + 1n : q);
}

/**
 * A rational as a recipe's exact time.
 * @param a - The value.
 * @returns It as numbers.
 */
function exact(a: Rational): Exact { return { numerator: Number(a.n), denominator: Number(a.d) }; }

/**
 * A rational in seconds.
 * @param a - The value.
 * @returns Its number.
 */
function seconds(a: Rational): number { return Number(a.n) / Number(a.d); }

/**
 * Parse "num/den" (ffprobe's time base or rate).
 * @param text - The text.
 * @returns The rational.
 */
function parseRatio(text: string): Rational {
  const [n, d = "1"] = text.split("/");
  return rat(BigInt(n!), BigInt(d));
}

/** What the oracle reads of a file. */
export interface GridFacts {
  grid: GridRef;
  source: ToolSourceRef;
  /** The first decoded video frame's time and the audio end, as seconds. */
  firstVideo: number;
  audioEnd: number | null;
  width: number;
  height: number;
}

/**
 * The integer timestamps ffprobe reports for one stream, in its time base.
 * @param path - The file.
 * @param stream - `v:0` or `a:0`.
 * @param section - `frame` (decoded, FFmpeg's default interpretation) or `packet`.
 * @param entries - The fields read.
 * @returns The rows.
 */
async function rows(path: string, stream: string, section: string, entries: string): Promise<string[][]> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", `${section}=${entries}`, "-of", "csv=p=0", path], { maxBuffer: 1 << 28 });
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "").map((line) => line.split(","));
}

/**
 * Read a file's grid as the design states it (§4.1): gridStart = the earlier of the first decoded video frame and the first
 * decoded audio frame; V = round((last video frame − gridStart) × fps) + 1; frameCount = max(V, ceil((audio end − gridStart) × fps))
 * with the audio end the last audio packet's pts plus its duration (no container timestamp precision: MP4, MOV, AVI and TS
 * are exact), or V when `withAudio` is false or the file has no audio. Keyframe statistics (§7.16): packets read without
 * `-ignore_editlist`, each timed by its pts or else its dts; the earliest keyframe packet time (discarded keyframes count)
 * and the largest keyframe interval including the last GOP (the whole span when there is one keyframe); allKeyframes when
 * every packet is a keyframe.
 * @param path - The file.
 * @param fps - The grid rate (the sample set's rate table gives it).
 * @param withAudio - Whether the audio end extends the grid.
 * @returns The facts.
 */
export async function gridOf(path: string, fps: FrameRate, withAudio = true): Promise<GridFacts> {
  const streams = JSON.parse((await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path])).stdout) as { streams: Record<string, unknown>[] };
  const video = streams.streams.find((stream) => stream.codec_type === "video")!;
  const audio = streams.streams.find((stream) => stream.codec_type === "audio");
  const vBase = parseRatio(String(video.time_base));
  const at = (ticks: string, base: Rational): Rational => rat(BigInt(ticks) * base.n, base.d);
  const vFrames = (await rows(path, "v:0", "frame", "best_effort_timestamp")).map(([t]) => t!).filter((t) => t !== "N/A").map((t) => at(t, vBase));
  const firstVideo = vFrames.reduce((a, b) => (cmp(a, b) <= 0 ? a : b));
  const lastVideo = vFrames.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
  let gridStart = firstVideo;
  let audioEnd: Rational | null = null;
  if (audio !== undefined) {
    const aBase = parseRatio(String(audio.time_base));
    const aFrames = (await rows(path, "a:0", "frame", "best_effort_timestamp")).map(([t]) => t!).filter((t) => t !== "N/A").map((t) => at(t, aBase));
    const firstAudio = aFrames.reduce((a, b) => (cmp(a, b) <= 0 ? a : b));
    if (cmp(firstAudio, gridStart) < 0) gridStart = firstAudio;
    const packets = (await rows(path, "a:0", "packet", "pts,duration")).filter(([pts, duration]) => pts !== "N/A" && duration !== "N/A");
    const [pts, duration] = packets.at(-1)!;
    audioEnd = at(String(BigInt(pts!) + BigInt(duration!)), aBase);
  }
  const rate = rat(BigInt(fps.numerator), BigInt(fps.denominator));
  const slots = (time: Rational): Rational => rat(time.n * rate.n, time.d * rate.d);
  const realFrameCount = roundNear(slots(sub(lastVideo, gridStart))) + 1;
  const frameCount = withAudio && audioEnd !== null ? Math.max(realFrameCount, ceil(slots(sub(audioEnd, gridStart)))) : realFrameCount;
  const packets = await rows(path, "v:0", "packet", "pts,dts,flags");
  const times = packets.map(([pts, dts, flags]) => ({ time: pts !== "N/A" ? pts! : dts!, key: flags!.includes("K") })).filter((p) => p.time !== "N/A")
    .map((p) => ({ time: at(p.time, vBase), key: p.key })).sort((a, b) => cmp(a.time, b.time));
  const keys = times.filter((p) => p.key).map((p) => p.time);
  const lastPacket = times.at(-1)!.time;
  const gaps = [...keys.slice(1).map((key, i) => sub(key, keys[i]!)), sub(lastPacket, keys.at(-1)!)];
  const maxInterval = keys.length === 1 ? sub(lastPacket, times[0]!.time) : gaps.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
  return {
    grid: { fps, gridStart: exact(gridStart), frameCount, realFrameCount },
    source: { kind: "original", keyframes: { earliestKeyframeTime: seconds(keys[0]!), maxKeyframeInterval: seconds(maxInterval), allKeyframes: keys.length === times.length } },
    firstVideo: seconds(firstVideo),
    audioEnd: audioEnd === null ? null : seconds(audioEnd),
    width: Number(video.width), height: Number(video.height),
  };
}

/**
 * The design's placement chain (§4.1 源帧落位 row), cut to the slots [k0, k1).
 * @param grid - The grid.
 * @param k0 - First slot.
 * @param k1 - End slot.
 * @returns The filter chain.
 */
export function gridChain(grid: GridRef, k0 = 0, k1 = grid.frameCount): string {
  const fps = `${grid.fps.numerator}/${grid.fps.denominator}`;
  return `setpts=PTS-(${grid.gridStart.numerator}/${grid.gridStart.denominator})/TB,tpad=stop_mode=clone:stop=-1,fps=${fps}:start_time=0:round=near:eof_action=pass,trim=start_frame=${k0}:end_frame=${k1}`;
}

/**
 * Decode a file's frames to raw pictures.
 * @param path - The file.
 * @param format - `rgb24` or `rgba`.
 * @param filter - A chain before the conversion (the grid chain for the oracle).
 * @param input - Input options.
 * @returns The frames.
 */
export async function rawFrames(path: string, format: "rgb24" | "rgba", filter?: string, input: string[] = []): Promise<Buffer[]> {
  const probe = await run("ffmpeg", ["-hide_banner", "-v", "info", ...input, "-i", path, "-map", "0:v:0", "-frames:v", "1", "-vf", `${filter === undefined ? "" : `${filter},`}showinfo`, "-f", "null", "-"]);
  const size = /Parsed_showinfo.* s:(\d+)x(\d+)/u.exec(probe.stderr);
  expect(size, `the size of ${path}'s first picture`).not.toBeNull();
  const { stdout } = await run("ffmpeg", ["-v", "error", ...input, "-i", path, "-map", "0:v:0", "-vf", `${filter === undefined ? "" : `${filter},`}format=${format}`, "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 30 });
  const bytes = stdout as unknown as Buffer;
  const frame = Number(size![1]) * Number(size![2]) * (format === "rgba" ? 4 : 3);
  return Array.from({ length: bytes.length / frame }, (_, i) => bytes.subarray(i * frame, (i + 1) * frame));
}

/**
 * The oracle: the whole file through the grid chain (§4.1), one picture per slot.
 * @param path - The file.
 * @param grid - The grid.
 * @param format - The raw format.
 * @returns frameCount pictures.
 */
export async function oracleFrames(path: string, grid: GridRef, format: "rgb24" | "rgba" = "rgb24"): Promise<Buffer[]> {
  // `-copyts`: the grid start is a source time as ffprobe reads it, so the decode keeps the source's own timestamps; without
  // it the CLI moves a source that starts late (an MPEG-TS from 1.48 s) to 0 and the chain shifts it a second time.
  const frames = await rawFrames(path, format, gridChain(grid), ["-copyts"]);
  expect(frames, "the oracle decode yields one picture per grid slot").toHaveLength(grid.frameCount);
  return frames;
}

/**
 * The mean absolute difference of two pictures, Infinity when their sizes differ.
 * @param a - One.
 * @param b - The other.
 * @returns The difference per byte.
 */
export function mad(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i]! - b[i]!);
  return total / a.length;
}

/**
 * Expect a produced picture to be the oracle's slot: within conversion noise of it and no farther from it than from any
 * other slot whose picture differs from it by more than that noise (repeated slots of a pad or a hold tie).
 * @param actual - The produced picture.
 * @param oracle - The oracle's pictures.
 * @param slot - The expected slot.
 * @param label - What is compared.
 */
export function expectSlot(actual: Buffer, oracle: readonly Buffer[], slot: number, label: string): void {
  const own = mad(actual, oracle[slot]!);
  // Only source frames told apart from this slot's by more than the noise can be nearer: near-still footage repeats a
  // picture within the noise across slots, and an encoded slot then lands as close to the repeat as to its own.
  const nearest = oracle.map((frame, at) => ({ at, distance: mad(actual, frame) }))
    .filter(({ at, distance }) => at === slot || distance >= own || mad(oracle[at]!, oracle[slot]!) > NOISE)
    .sort((a, b) => a.distance - b.distance)[0]!;
  expect(own, `${label}: slot ${slot} differs by ${own}; nearest is slot ${nearest.at} at ${nearest.distance}`).toBeLessThanOrEqual(Math.min(NOISE, nearest.distance + 1e-9));
}

/**
 * The largest mean difference two decodes of one picture may show: RGB conversion with other scaler flags measured up to
 * about 3.3 on these samples, while neighbouring source frames differ by more.
 */
export const NOISE = 4;

/** What one planned job did: its report and the bytes each output URL received. */
export interface JobOutcome { report: { ok: boolean; reason?: string; outputs?: Record<string, unknown>[] }; written: Map<string, Uint8Array> }

const served = new Map<string, string>();
const written = new Map<string, Uint8Array>();
const reports = new Map<string, JobOutcome["report"]>();
let attempts = 0;

/**
 * A job input as the Worker serves it (`serveOneObject`): the whole object with its length and `accept-ranges: bytes`, or
 * the asked byte range as 206, which the loopback reader resumes and seeks with.
 * @param bytes - The object.
 * @param init - The request, for its Range header.
 * @returns The answer.
 */
export function servedObject(bytes: Uint8Array, init?: RequestInit): Response {
  const asked = /^bytes=(\d+)-(\d*)$/u.exec(new Headers(init?.headers).get("range") ?? "");
  if (asked === null) return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength), "accept-ranges": "bytes" } });
  const start = Number(asked[1]);
  const end = asked[2] === "" ? bytes.byteLength - 1 : Math.min(Number(asked[2]), bytes.byteLength - 1);
  return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
    "content-length": String(end + 1 - start), "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.byteLength}` } });
}

/**
 * Stub the container's fetch: GETs read served files, PUTs are kept per URL, POSTed reports per attempt id. Call in
 * `beforeEach`.
 */
export function stubContainerFetch(): void {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === "PUT") { written.set(url, new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(null, { status: 200 }); }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as JobOutcome["report"] & { attemptId: string };
      reports.set(body.attemptId, body);
      return new Response(null, { status: 200 });
    }
    const path = served.get(url);
    if (path === undefined) return new Response(null, { status: 404 });
    return servedObject(await readFile(path), init);
  }));
}

/** One output of a planned job. */
export interface PlannedOutput { recipe: Record<string, unknown>; contentType: string }

/**
 * Run one planned job. Every recipe must first parse as the worker writes it (the planned job schema is what admits it),
 * then the container executes it.
 * @param inputs - Input id to local file.
 * @param outputs - The outputs.
 * @returns The report and each output's bytes in output order.
 */
export async function runJob(inputs: Record<string, string>, outputs: readonly PlannedOutput[]): Promise<{ report: JobOutcome["report"]; bytes: (Uint8Array | undefined)[] }> {
  for (const output of outputs) {
    const parsed = miniToolPlanRecipeSchema.safeParse(output.recipe);
    expect(parsed.success, `the planned job schema admits the ${String(output.recipe.kind)} grid recipe: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
  }
  attempts += 1;
  const attemptId = `30000000-0000-4000-8000-${String(attempts).padStart(12, "0")}`;
  const bound = Object.entries(inputs).map(([inputId, path]) => {
    const url = `http://inputs.test/${attemptId}/${inputId}`;
    served.set(url, path);
    return { inputId, url };
  });
  const urls = outputs.map((_, at) => `http://outputs.test/${attemptId}/o${at}`);
  await runPlanJob({ schemaVersion: 2, attemptId, deadlineAt: Date.now() + 3_600_000, limits: LIMITS, inputs: bound,
    outputs: outputs.map((output, at) => ({ outputIndex: at, key: `results/T/${attemptId}/o${at}`, url: urls[at]!, contentType: output.contentType, recipe: output.recipe })),
    reportUrl: "http://jobs.test/report" } as unknown as PlanRunBody);
  return { report: reports.get(attemptId) ?? { ok: false, reason: "no report" }, bytes: urls.map((url) => written.get(url)) };
}

/**
 * Run one planned job whose every output must succeed, and return the bytes.
 * @param inputs - Input id to local file.
 * @param outputs - The outputs.
 * @returns Each output's bytes.
 */
export async function produce(inputs: Record<string, string>, outputs: readonly PlannedOutput[]): Promise<Uint8Array[]> {
  const { report, bytes } = await runJob(inputs, outputs);
  expect(report.ok, `the job reports ok (${JSON.stringify(report)}; ${JSON.stringify(vi.mocked(console.error).mock.calls.slice(-3))})`).toBe(true);
  return bytes.map((value) => value!);
}
