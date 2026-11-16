// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The standard-4 presentation recipes (frames-split design §4.3, §5.3, §5.4, §7.17; inner#1306 §91 D3): a chunk or model
 * input renders its window's entries on its own clock from 0, the stitch joins the chunks by stream copy for their plan
 * durations and adds the interval's audio, and the copy keeps every packet and tags the plan matrix. The recipe carries
 * what the worker wrote from the full ledger; nothing here reads the ledger.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rational } from "@shared/mini-tools/video-presentation-projection.js";
import { conformedTime } from "@shared/mini-tools/video-encode-plan.js";
import type {
  MiniToolPlanAudio, MiniToolPlanEntry, MiniToolPlanExact, MiniToolPlanExpandComposite, MiniToolPlanPixelRect, MiniToolPlanRecipe, MiniToolPlanStitch,
  MiniToolPlanTarget, MiniToolPlanTransitionProfile, MiniToolPlanTransitionStitch, MiniToolPlanTransitionWindow,
} from "@shared/upload/mini-tool-plan-types.js";
import type { ContainerFailure } from "@shared/mini-tools/types.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { copyWithMatrixTag } from "@ingest/container/presentation-run.js";
import { TAGGED_MATRICES, videoContainerCrop } from "@ingest/container/physical-video-probe.js";
import { displayTurn } from "@ingest/container-crop.js";
import { alphaDecoderArgs, probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pickMediaMetadata } from "@ingest/media-metadata.js";
import { pngSize } from "@ingest/png-size.js";
import { runAnalysisPipeline } from "@ingest/container/analysis-pipeline.js";
import { readSceneCutObservations, readYuNetFaces } from "@ingest/container/analysis-detection.js";

/** A recipe that ends on a property of its input, reported as the job's reason (§97 D18-3, D20-5) rather than `tool_failed`. */
export class RecipeFailure extends Error {
  /**
   * Name the reason.
   * @param reason - The report's reason.
   */
  constructor(readonly reason: ContainerFailure) { super(reason); this.name = "RecipeFailure"; }
}

/** Caller-frozen process IO bounds, with no local operational fallback. */
export interface PlanLimits { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number }
/** The recipes this module runs. */
export type PresentationRecipe = Extract<MiniToolPlanRecipe, { kind: "copy_carrier" | "chunk_encode" | "prepare_model_input" }> | MiniToolPlanStitch
  | FrameRecipe | PeopleRecipe | SceneRecipe | SegmentRecipe | MiniToolPlanTransitionStitch | MiniToolPlanTransitionWindow | MiniToolPlanExpandComposite;
/** A still frame on a full-ledger entry (§91 D4-3). */
type FrameRecipe = Extract<MiniToolPlanRecipe, { kind: "frame"; entry: MiniToolPlanEntry }>;
/** People detection on the anchor's entry (§91 D4-5). */
type PeopleRecipe = Extract<MiniToolPlanRecipe, { kind: "people"; entry: MiniToolPlanEntry }>;
/** Scene detection over a window's entries (§91 D4-5). */
type SceneRecipe = Extract<MiniToolPlanRecipe, { kind: "scene_cuts"; entries: unknown }>;
/** A split segment on a window's entries (§91 D4-4). */
type SegmentRecipe = Extract<MiniToolPlanRecipe, { kind: "segment"; entries: unknown }>;
/** The process lifetime and IO bounds of one command. */
type Run = { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number };
/** One recipe's local files and lifetime. */
export interface PresentationRecipeRequest {
  /** Any admitted recipe but the lip-sync steps, which `lipsync-recipes.ts` runs. */
  recipe: PresentationRecipe;
  /** Downloaded files by bound input id: the recipe's input and, for a stitch, every chunk. */
  inputs: ReadonlyMap<string, string>;
  output: string;
  directory: string;
  signal: AbortSignal;
  limits: PlanLimits;
}

/**
 * What the tone map reads of a source's decoded frames beyond its plan (§4.3 colour/HDR row), as zscale names: the transfer,
 * the primaries (BT.709 when untagged, as Chromium reads them), the range (limited when untagged) and the chroma location
 * (left when unspecified, as zimg reads it); for a planar subsampled stream with an odd subsampled side, which zimg cannot
 * read, its planar format and decoded size; and the container cropping the graph applies itself.
 */
export interface FrameColour {
  transfer: string | null;
  primaries: string;
  range: "tv" | "pc";
  chromaLocation: string;
  odd: OddFrames | null;
  /** The display turn the graph applies itself on full-chroma frames, with autorotate off; null when FFmpeg's autorotate turns them. */
  turn: string | null;
  /** The exact crop of a Matroska PixelCrop on full-chroma frames before the turn (the decoder's own crop is off); null for none. */
  crop: string | null;
}
/**
 * How odd-sided planar subsampled frames reach the graph: their planar format (alpha included when the decoder hands it out),
 * their size there, the directions their chroma is subsampled in, the directions FFmpeg's autorotate reversed (whose chroma
 * grid then starts at the far edge, so the even frame is padded at the near one).
 */
export interface OddFrames {
  format: string;
  alpha: boolean;
  width: number;
  height: number;
  hsub: boolean;
  vsub: boolean;
  leadX: boolean;
  leadY: boolean;
}
// The plan's matrix names (physical-video-probe.ts) as zscale spells them.
const ZSCALE_MATRICES: Readonly<Record<string, string>> = { bt709: "709", bt601: "170m", bt2020nc: "2020_ncl" };

/**
 * Odd-sided planar subsampled frames as even ones (§4.3 odd-size row): taken to their planned size (a mid-stream size change
 * keeps the graph's sizes), then every plane padded to the even frame's plane size: luma and alpha in both directions, chroma
 * only where it is not subsampled, so the decoded chroma samples cover the pixels they cover on an even frame. Padding goes at
 * the near edge of a direction autorotate reversed. The merged frame carries no colour tags; its readers name matrix and range.
 * @param odd - How the frames reach the graph.
 * @param label - A label prefix unique within the graph.
 * @param keepAlpha - Whether an alpha plane is carried.
 * @returns The filter chain text, ending on the even frame.
 * @throws {never} Never.
 */
function evenPlanes(odd: OddFrames, label: string, keepAlpha: boolean): string {
  const [width, height] = evenSize(odd);
  const [x, y] = evenOffset(odd);
  const alpha = keepAlpha && odd.alpha;
  const format = alpha ? odd.format : odd.format.replace(/^yuva/u, "yuv");
  // A full-chroma direction's padding repeats the edge: swscale's chroma filter there reaches past the last column or row.
  const [left, right, top, bottom] = [x, width - odd.width - x, y, height - odd.height - y];
  const smear = (h: boolean, v: boolean): string =>
    `fillborders=left=${h ? left : 0}:right=${h ? right : 0}:top=${v ? top : 0}:bottom=${v ? bottom : 0}:mode=smear`;
  const chroma = (plane: string): string => (odd.hsub || odd.width % 2 === 0) && (odd.vsub || odd.height % 2 === 0) ? ""
    : `[${label}${plane}]pad=${odd.hsub ? width / 2 : width}:${odd.vsub ? height / 2 : height}:${odd.hsub ? 0 : x}:${odd.vsub ? 0 : y},${smear(!odd.hsub, !odd.vsub)}[${label}${plane}p];`;
  const [u, v] = [chroma("u"), chroma("v")];
  const full = `pad=${width}:${height}:${x}:${y},${smear(true, true)}`;
  return `scale=${odd.width}:${odd.height},format=${odd.format},extractplanes=y+u+v${alpha ? "+a" : ""}[${label}y][${label}u][${label}v]${alpha ? `[${label}a]` : ""};` +
    `[${label}y]${full}[${label}p];${alpha ? `[${label}a]${full}[${label}q];` : ""}${u}${v}` +
    `[${label}p][${label}u${u === "" ? "" : "p"}][${label}v${v === "" ? "" : "p"}]${alpha ? `[${label}q]` : ""}` +
    `mergeplanes=map0s=0:map0p=0:map1s=1:map1p=0:map2s=2:map2p=0${alpha ? ":map3s=3:map3p=0" : ""}:format=${format}`;
}

/**
 * The even size odd frames are padded to.
 * @param odd - How the frames reach the graph.
 * @returns The width and height.
 * @throws {never} Never.
 */
function evenSize(odd: OddFrames): [number, number] {
  return [odd.width + odd.width % 2, odd.height + odd.height % 2];
}

/**
 * Where the odd frames sit in their even frame: one pixel in on a reversed odd direction.
 * @param odd - How the frames reach the graph.
 * @returns The x and y offsets.
 * @throws {never} Never.
 */
function evenOffset(odd: OddFrames): [number, number] {
  return [odd.leadX ? odd.width % 2 : 0, odd.leadY ? odd.height % 2 : 0];
}

/**
 * The odd frames cropped back out of their even frame.
 * @param odd - How the frames reach the graph.
 * @returns The filter chain text.
 * @throws {never} Never.
 */
function oddBack(odd: OddFrames): string {
  const [x, y] = evenOffset(odd);
  return `crop=${odd.width}:${odd.height}:${x}:${y}:exact=1`;
}

/**
 * Frames converted to a format at a size (§4.3 odd-size row). swscale subsamples chroma at the right places only on even
 * sides, so an odd picture going to a subsampled format is converted to full chroma, padded to even with its last column and
 * row repeated, subsampled, and cropped back: each chroma sample covers the pixels it covers on an even picture.
 * @param width - The width.
 * @param height - The height.
 * @param options - The scale options before the output ones, starting with the size.
 * @param output - The output format and whether it is converted to limited-range BT.709.
 * @returns The filter chain text.
 * @throws {never} Never.
 */
function converted(width: number, height: number, options: string, output: PictureOutput): string {
  const scale = `scale=${width}:${height}${options}${output.bt709 === true ? ":out_color_matrix=bt709:out_range=tv" : ""}`;
  return `${scale},${subsampledAt(width, height, output.format)}`;
}

/**
 * Full-chroma frames as a format at their size, subsampled on an even picture when a side is odd (`converted`).
 * @param width - The frames' width.
 * @param height - The frames' height.
 * @param format - The output format.
 * @returns The filter chain text.
 * @throws {never} Never.
 */
export function subsampledAt(width: number, height: number, format: string): string {
  const sub = /^(yuva?)(420|422|440)p/u.exec(format);
  if (sub === null || (width % 2 === 0 && height % 2 === 0)) return `format=${format}`;
  return `format=${format.replace(/^(yuva?)(420|422|440)p/u, "$1444p")},pad=${width + width % 2}:${height + height % 2}:0:0,` +
    `fillborders=right=${width % 2}:bottom=${height % 2}:mode=smear,format=${format},crop=${width}:${height}:0:0:exact=1`;
}

/** The format a decoded picture is converted to, and whether to limited-range BT.709. */
export interface PictureOutput { format: string; bt709?: boolean }

/**
 * The D05 tone map (§4.3 colour/HDR row). The chain's first step names every input fact: the plan's matrix and the probed
 * transfer, primaries, range and chroma location, so a tag missing from the frames cannot stop zscale. An odd-sided
 * subsampled frame reaches zimg with only its luma plane padded to the even size and its chroma planes as decoded, then the
 * picture is cropped back: zimg places each chroma sample as on the even frame, so every pixel equals the D05 picture of the
 * same samples. With `keepAlpha` the alpha plane is extracted beside the chain and merged back after it (the chain's float RGB
 * has none, and zscale reads a YUVA source's alpha as limited range); an opaque frame gets an opaque alpha.
 * @param matrix - The plan matrix.
 * @param colour - The decoded frames' colour facts.
 * @param label - A label prefix unique within the graph.
 * @param keepAlpha - Whether the frames' alpha is carried through.
 * @returns The filter chain text, ending on tone-mapped frames.
 * @throws {RangeError} When the plan matrix has no zscale value.
 */
function toneMap(matrix: string, colour: FrameColour, label: string, keepAlpha: boolean): string {
  const min = ZSCALE_MATRICES[matrix];
  if (min === undefined) throw new RangeError(`No tone map matrix for ${matrix}`);
  const inputs = `${colour.transfer === null ? "" : `tin=${colour.transfer}:`}pin=${colour.primaries}:p=${colour.primaries}:min=${min}:rin=${colour.range}:cin=${colour.chromaLocation}`;
  const chain = `zscale=${inputs}:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`;
  const { odd } = colour;
  const mapped = odd === null ? chain : `${evenPlanes(odd, `${label}t`, false)},${chain},${oddBack(odd)}`;
  const turn = `${colour.crop === null ? "" : `,${colour.crop}`}${colour.turn === null ? "" : `,${colour.turn}`}`;
  if (!keepAlpha) return `${mapped}${turn}`;
  return `split[${label}tc][${label}ta];[${label}ta]format=yuva444p,alphaextract[${label}tm];[${label}tc]${mapped}[${label}tt];[${label}tt][${label}tm]alphamerge${turn}`;
}
export const BT709_TAGS = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
// The plan's matrix names (physical-video-probe.ts) as the scale filter spells them.
const SCALE_MATRICES: Readonly<Record<string, string>> = { bt709: "bt709", bt601: "bt601", bt2020nc: "bt2020" };

/**
 * Subtract two exact times.
 * @param left - The minuend.
 * @param right - The subtrahend.
 * @returns The exact difference.
 * @throws {RangeError} When a time is malformed.
 */
export function minus(left: MiniToolPlanExact, right: MiniToolPlanExact): [bigint, bigint] {
  const [a, b] = rational(left);
  const [c, d] = rational(right);
  return [a * d - c * b, b * d];
}

/**
 * Round a non-negative exact value times a scale to the nearest integer.
 * @param value - The numerator and denominator.
 * @param scale - The multiplier.
 * @returns The rounded product.
 * @throws {RangeError} When the value is negative.
 */
export function roundTimes([numerator, denominator]: [bigint, bigint], scale: bigint): bigint {
  if (numerator < 0n) throw new RangeError("Presentation entries run forward from the window start");
  return (2n * numerator * scale + denominator) / (2n * denominator);
}

/**
 * An exact time as FFmpeg seconds, rounded to the nanosecond.
 * @param value - The numerator and denominator.
 * @returns The decimal text.
 * @throws {RangeError} When the value is negative.
 */
export function seconds(value: [bigint, bigint]): string {
  const nanos = roundTimes(value, 1_000_000_000n);
  return `${nanos / 1_000_000_000n}.${String(nanos % 1_000_000_000n).padStart(9, "0")}`;
}

/**
 * The presentation interval an entry covers.
 * @param entry - The entry.
 * @returns Its start and end.
 * @throws {never} Never.
 */
export function span(entry: MiniToolPlanEntry): { start: MiniToolPlanExact; end: MiniToolPlanExact } {
  return entry.kind === "source" ? { start: entry.displayStart, end: entry.displayEnd } : entry.window;
}

/**
 * Where the picture sits in the coded frame: the display rectangle, or the whole frame (one plane when alpha is packed).
 * @param target - The carrier target.
 * @returns The picture rectangle and the plane width.
 * @throws {never} Never.
 */
export function placement(target: MiniToolPlanTarget): { rect: MiniToolPlanPixelRect; planeWidth: number } {
  const planeWidth = target.alpha === "packed" ? target.width / 2 : target.width;
  return { rect: target.displayRect ?? { x: 0, y: 0, width: planeWidth, height: target.height }, planeWidth };
}

/**
 * The filters that tone map HDR frames and scale them with the plan matrix (§4.3 colour/HDR row), before any output conversion.
 * @param source - The plan's matrix and tone mapping.
 * @param source.colorMatrix - The plan matrix.
 * @param source.toneMap - The tone mapping.
 * @param width - The scaled width.
 * @param height - The scaled height.
 * @param colour - The decoded frames' colour facts; null only for frames that are not tone mapped.
 * @param label - A label prefix unique within the graph.
 * @param output - The format the frames are converted to and whether to limited-range BT.709.
 * @param keepAlpha - Whether the frames' alpha is carried.
 * @returns The filter chain text, ending on frames of the output format at the size.
 * @throws {RangeError} When the plan matrix has no decode value, or HDR frames come without their colour facts.
 */
export function decodedPicture(source: { colorMatrix: string; toneMap: "none" | "sdr-bt709" }, width: number, height: number, colour: FrameColour | null,
  label: string, output: PictureOutput, keepAlpha = false): string {
  const matrix = SCALE_MATRICES[source.colorMatrix];
  if (matrix === undefined) throw new RangeError(`No decode matrix for ${source.colorMatrix}`);
  if (source.toneMap === "sdr-bt709") {
    if (colour === null) throw new RangeError("Tone-mapped frames need their colour facts");
    return `${toneMap(source.colorMatrix, colour, label, keepAlpha)},${converted(width, height, `:in_color_matrix=${matrix}`, output)}`;
  }
  const odd = colour?.odd ?? null;
  const turns = [colour?.crop ?? null, colour?.turn ?? null].filter((step) => step !== null);
  const turn = turns.length === 0 ? null : turns.join(",");
  const read = colour === null ? "" : `:in_color_matrix=${matrix}:in_range=${colour.range}`;
  const full = keepAlpha && (odd?.alpha ?? true) ? "yuva444p16le" : "yuv444p16le";
  if (odd === null) {
    if (turn === null) return converted(width, height, `:in_color_matrix=${matrix}`, output);
    return `scale=w=iw:h=ih${read}:out_color_matrix=${matrix}:out_range=${colour!.range},format=${full},${turn},${converted(width, height, read, output)}`;
  }
  // An odd-sided subsampled source is converted on its even frame: at its own size the output is cropped back, so each pixel
  // equals its even twin's; scaled, cropped or turned here, it becomes full chroma there first and is scaled from that.
  const [evenWidth, evenHeight] = evenSize(odd);
  const even = evenPlanes(odd, `${label}e`, keepAlpha);
  if (turn === null && width === odd.width && height === odd.height) return `${even},${converted(evenWidth, evenHeight, read, output)},${oddBack(odd)}`;
  return `${even},scale=${evenWidth}:${evenHeight}${read}:out_color_matrix=${matrix}:out_range=${colour!.range},format=${full},${oddBack(odd)},` +
    `${turn === null ? "" : `${turn},`}${converted(width, height, read, output)}`;
}

/**
 * The scale options that decode a model's video result (erase, expand, lip-sync), from the result's own tags: its
 * `color_space` mapped as a source's is, and BT.601 when untagged, because the providers encode RGB with swscale's default
 * and write no tags (measured on VACE expand and Bria eraser output, 720p included, so the source rule's BT.709 for an
 * untagged stream of 720 lines or more does not hold here); its `color_range`, and limited range when untagged.
 * @param stream - The result's ffprobe video stream, read for its `color_space` and `color_range`.
 * @returns The `in_color_matrix` and `in_range` options.
 * @throws {RangeError} When the tagged matrix has no decode value.
 */
export function modelResultDecode(stream: Record<string, unknown>): string {
  const tag = typeof stream.color_space === "string" && stream.color_space !== "" && stream.color_space !== "unknown" ? stream.color_space : null;
  const matrix = SCALE_MATRICES[tag === null ? "bt601" : TAGGED_MATRICES[tag] ?? tag];
  if (matrix === undefined) throw new RangeError(`No decode matrix for ${String(tag)}`);
  return `in_color_matrix=${matrix}:in_range=${stream.color_range === "pc" ? "pc" : "tv"}`;
}

/**
 * Probe a model's video result for its colour tags and return the scale options that decode it ({@link modelResultDecode}).
 * @param file - The result.
 * @param run - The lifetime and IO bounds.
 * @returns The `in_color_matrix` and `in_range` options.
 * @throws {RangeError} When the tagged matrix has no decode value.
 * @throws {Error} When ffprobe fails.
 */
export async function probeModelResultDecode(file: string, run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<string> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries", "stream=color_space,color_range",
    "-of", "json", file], run)).toString("utf8")) as { streams?: Record<string, unknown>[] };
  return modelResultDecode(answer.streams?.[0] ?? {});
}

/**
 * The filters that turn decoded display frames into the target picture (§4.3 odd-size and colour/HDR/bit-depth rows, §3.5): HDR
 * tone mapped, decoded with the plan matrix, scaled to the picture rectangle and padded around it to the even coded size;
 * an alpha source is packed premultiplied colour left and alpha right as `alpha-presentation.ts` packs it.
 * @param target - The carrier target.
 * @param label - A label prefix unique within the graph.
 * @param colour - The decoded frames' colour facts; null only for frames that are not tone mapped.
 * @returns The filter chain text, ending on 8-bit BT.709 4:2:0 frames.
 * @throws {RangeError} When the plan matrix has no decode value, or HDR frames come without their colour facts.
 */
export function picture(target: MiniToolPlanTarget, label: string, colour: FrameColour | null): string {
  const { rect, planeWidth } = placement(target);
  /**
   * The decoded picture in the rectangle, as a format.
   * @param output - The format and whether to limited-range BT.709.
   * @returns The filter chain text.
   * @throws {RangeError} When the plan matrix has no decode value.
   */
  const head = (output: PictureOutput): string => decodedPicture(target, rect.width, rect.height, colour, `${label}a`, output, target.alpha !== "none");
  const pad = `pad=${planeWidth}:${target.height}:${rect.x}:${rect.y}:color=black`;
  // The frames are already upright; a display matrix left on them would be written to the output and rotate it again.
  const unrotated = `${BT709_TAGS},sidedata=mode=delete:type=DISPLAYMATRIX`;
  // A VP9 split output keeps its display size, odd sides included, and its straight alpha (§4.3 odd-size row, §91 D4-4); a VP9
  // transition chunk sits in its fitted rectangle, the bars transparent when it keeps alpha (§7.17).
  if (target.format === "webm-vp9") {
    const straight = target.alpha === "straight";
    const [full, sub] = straight ? ["yuva444p", "yuva420p"] : ["yuv444p", "yuv420p"];
    if (target.displayRect === null) return `${head({ format: sub, bt709: true })},setsar=1,${unrotated}`;
    // Padded in 4:4:4: a 4:2:0 pad rounds an odd offset down and cannot make an odd side.
    return `${head({ format: full, bt709: true })},pad=${target.width}:${target.height}:${rect.x}:${rect.y}:color=black${straight ? "@0" : ""},` +
      `${subsampledAt(target.width, target.height, sub)},setsar=1,${unrotated}`;
  }
  const tail = `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,${unrotated}`;
  if (target.alpha === "none") return `${head({ format: "yuv444p", bt709: true })},${pad},${tail}`;
  return `${head({ format: "gbrap" })},split=2[${label}r][${label}a];[${label}r]premultiply=inplace=1,format=rgb24,${pad}[${label}c];` +
    `[${label}a]alphaextract,format=rgb24,${pad}[${label}m];[${label}c][${label}m]hstack,${tail}`;
}

// FFmpeg's sample rates are C ints.
const MAX_SAMPLE_RATE = 2147483647n;

/**
 * Relabel 48 kHz samples to play at a reduced rate a/b (§4.2 rational relabel: no atempo, no pitch preservation; design line
 * 858): resample to b·m Hz, declare those samples a·m Hz, and resample back to 48 kHz, so every sample's time is divided by
 * a/b exactly. m = ceil(48000 / b) keeps the intermediate rate at or above 48 kHz, so no bandwidth is lost and the rate stays
 * below 48000 + b.
 * @param rate - The reduced rate.
 * @returns The filter chain, empty at rate 1.
 * @throws {RangeError} When the relabelled rate exceeds FFmpeg's sample-rate range.
 */
function relabel([numerator, denominator]: [bigint, bigint]): string {
  if (numerator === denominator) return "";
  const scale = (48000n + denominator - 1n) / denominator;
  if (numerator * scale > MAX_SAMPLE_RATE) throw new RangeError("The audio rate is beyond FFmpeg's sample-rate range");
  return `,aresample=${denominator * scale},asetrate=${numerator * scale},aresample=48000`;
}

/**
 * The audio of a presentation interval as AAC at 48 kHz from output time 0 (§4.2, §91 D3b-11, D4-2). With the plan's audio
 * spans the source is read on its media timeline (edit list ignored); each span's media samples, its bounds rounded to the
 * 48 kHz grid as FFmpeg `av_rescale` rounds (nearest, halves away from 0), are relabelled to its rate and placed at their
 * presentation sample. Without spans the edit list is applied and presentation time is movie time less the origin.
 * Silence before the first sample is kept.
 * @param input - The FFmpeg input index the source's audio is opened at.
 * @param audio - The recipe's audio.
 * @param label - The graph label the chain ends at, unique within the graph.
 * @returns The input arguments and the filter chain ending at `[label]`, or null when no span meets the interval.
 * @throws {RangeError} When a time is malformed.
 */
function audioOf(input: number, audio: MiniToolPlanAudio, label = "a"): { args: string[]; graph: string } | null {
  const start = rational(audio.start);
  const end = rational(audio.end);
  const pad = "aresample=48000:async=1:first_pts=0";
  if (audio.spans === null) {
    const movieStart = plus(start, rational(audio.origin));
    const movieEnd = plus(end, rational(audio.origin));
    return { args: ["-i"], graph: `[${input}:a:0]atrim=start=${seconds(movieStart)}:end=${seconds(movieEnd)},asetpts=PTS-(${seconds(movieStart)})/TB,${pad}[${label}]` };
  }
  const branches: string[] = [];
  for (const edit of audio.spans) {
    const rate = rational(edit.rate);
    const shownFrom = rational(edit.presentationStart);
    // Media [sourceStart, sourceEnd) is shown for its length / rate.
    const shownTo = plus(shownFrom, times(minusQ(rational(edit.sourceEnd), rational(edit.sourceStart)), [rate[1], rate[0]]));
    const from = later(shownFrom, start);
    const to = earlier(shownTo, end);
    if (!before(from, to)) continue;
    const mediaFrom = plus(rational(edit.sourceStart), times(minusQ(from, shownFrom), rate));
    const mediaTo = plus(mediaFrom, times(minusQ(to, from), rate));
    branches.push(`aresample=48000,atrim=start_pts=${roundTimes(mediaFrom, 48000n)}:end_pts=${roundTimes(mediaTo, 48000n)},asetpts=PTS-STARTPTS${relabel(rate)},` +
      `asetpts=PTS+${roundTimes(minusQ(from, start), 48000n)},${pad}`);
  }
  if (branches.length === 0) return null;
  const labels = branches.map((_branch, at) => `[${label}s${at}]`);
  const split = branches.length === 1 ? `[${input}:a:0]${branches[0]}[${label}]`
    : `[${input}:a:0]asplit=${branches.length}${labels.join("")};${branches.map((branch, at) => `${labels[at]}${branch}[${label}m${at}]`).join(";")};` +
      `${branches.map((_branch, at) => `[${label}m${at}]`).join("")}amix=inputs=${branches.length}:normalize=0:duration=longest[${label}]`;
  return { args: ["-ignore_editlist", "1", "-i"], graph: split };
}

/**
 * Add two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The sum.
 * @throws {never} Never.
 */
function plus(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return [left[0] * right[1] + right[0] * left[1], left[1] * right[1]];
}

/**
 * Multiply two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The product.
 * @throws {never} Never.
 */
function times(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return [left[0] * right[0], left[1] * right[1]];
}

/**
 * Subtract two exact values.
 * @param left - The minuend.
 * @param right - The subtrahend.
 * @returns The difference.
 * @throws {never} Never.
 */
function minusQ(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return [left[0] * right[1] - right[0] * left[1], left[1] * right[1]];
}

/**
 * Whether one exact value is below another.
 * @param left - One.
 * @param right - The other.
 * @returns Whether left is below right.
 * @throws {never} Never.
 */
function before(left: [bigint, bigint], right: [bigint, bigint]): boolean {
  return left[0] * right[1] < right[0] * left[1];
}

/**
 * The later of two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The larger.
 * @throws {never} Never.
 */
function later(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return before(left, right) ? right : left;
}

/**
 * The earlier of two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The smaller.
 * @throws {never} Never.
 */
function earlier(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  return before(left, right) ? left : right;
}

// The audio of every user-facing video output, at the bitrate the audio mini-tools write (src/jobs/op-args.ts AUDIO_OUT).
const AAC = ["-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"];

/**
 * What the recipes need to know of a source before reading it; `tick` is the first video stream's time base, `decoder` the
 * decoder options a VP9 or VP8 stream with alpha needs (FFmpeg's own decoders skip the alpha plane, which Matroska stores as a
 * BlockAdditional; only libvpx reads it, as alpha-presentation.ts decodes it).
 */
interface SourceFacts { iso: boolean; audio: boolean; mono: boolean; tick: [bigint, bigint] | null; decoder: string[]; colour: FrameColour }

/**
 * Whether the source is ISO BMFF (its edit lists are ignored so packet times are media time, the recipe's timeline;
 * design §7.17 timeline row) and whether it has audio: the plan does not record it, so a recipe always names its interval
 * and the output carries audio only when there is some (§91 D3b-2; §7.17 the first audio stream in ffprobe order).
 * @param source - The downloaded source.
 * @param run - The lifetime and IO bounds.
 * @returns The facts.
 * @throws {Error} When ffprobe fails.
 */
async function sourceFacts(source: string, run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<SourceFacts> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries",
    "format=format_name:stream=codec_type,codec_name,time_base,channels,width,height,pix_fmt,color_transfer,color_primaries,color_range,chroma_location:" +
    "stream_side_data=rotation,displaymatrix,crop_top,crop_bottom,crop_left,crop_right,side_data_type:stream_tags", "-of", "json", source], run)).toString("utf8")) as { format?: { format_name?: string };
    streams?: (ProbedVideo & { codec_type?: string; time_base?: string; channels?: number })[] };
  const names = (answer.format?.format_name ?? "").split(",");
  const video = (answer.streams ?? []).find((stream) => stream.codec_type === "video");
  const tick = /^(\d+)\/(\d+)$/u.exec(video?.time_base ?? "");
  const decoder = alphaDecoderArgs(video?.codec_name, Object.entries(video?.tags ?? {}).find(([key]) => key.toLowerCase() === "alpha_mode")?.[1]);
  const audio = (answer.streams ?? []).find((stream) => stream.codec_type === "audio");
  const colour = frameColour(video ?? {}, answer.format?.format_name ?? "");
  // The decoders apply codec cropping only; a container's is the graph's (Matroska, exactly) or not applied (as Chromium).
  return { iso: names.includes("mov") || names.includes("mp4"), audio: audio !== undefined, mono: audio?.channels === 1,
    tick: tick === null ? null : [BigInt(tick[1]!), BigInt(tick[2]!)], decoder: [...decoder, "-apply_cropping", "codec", ...(colour.turn === null ? [] : ["-noautorotate"])], colour };
}

// Planar YUV formats whose chroma is subsampled: 4:2:0 halves both sides, 4:2:2 the width, 4:4:0 the height.
const PLANAR_SUBSAMPLED = /^yuv[aj]?(420|422|440)p(\d+(le|be))?$/u;
// The tags zscale reads by these names (its primaries, chroma location and transfer option values).
const ZSCALE_PRIMARIES: ReadonlySet<string> = new Set(["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "film", "bt2020", "smpte428", "smpte431", "smpte432", "jedec-p22", "ebu3213"]);
const CHROMA_LOCATIONS: ReadonlySet<string> = new Set(["left", "center", "topleft", "top", "bottomleft", "bottom"]);
const ZSCALE_TRANSFERS: ReadonlySet<string> = new Set(["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "linear", "log100", "log316", "iec61966-2-4",
  "iec61966-2-1", "bt2020-10", "bt2020-12", "smpte2084", "arib-std-b67"]);
/** A video stream as ffprobe reports what the recipes read of it. */
interface ProbedVideo {
  codec_name?: string; width?: number; height?: number; pix_fmt?: string; color_transfer?: string; color_primaries?: string; color_range?: string;
  chroma_location?: string; side_data_list?: { side_data_type?: string; rotation?: number; displaymatrix?: string }[]; tags?: Record<string, string>;
}

/**
 * The colour facts the tone map and the odd-frame conversion read of a video stream (`FrameColour`). A VP8/VP9 stream with
 * alpha decodes (through libvpx, `alphaDecoderArgs`) with an alpha plane ffprobe's pixel format does not show. A Matroska
 * PixelCrop reaches the graph uncropped and in its stored orientation, and is cropped exactly there before the turn.
 * @param video - The ffprobe video stream.
 * @param formatName - The ffprobe format name.
 * @returns The facts.
 * @throws {TypeError} When a cropping value is malformed.
 */
function frameColour(video: ProbedVideo, formatName: string): FrameColour {
  const known = (tag: string | undefined, names: ReadonlySet<string>): string | null => (tag !== undefined && names.has(tag) ? tag : null);
  const vpxAlpha = alphaDecoderArgs(video.codec_name, Object.entries(video.tags ?? {}).find(([key]) => key.toLowerCase() === "alpha_mode")?.[1]).length > 0;
  const format = vpxAlpha ? (video.pix_fmt ?? "").replace(/^yuv(?!a)/u, "yuva") : video.pix_fmt ?? "";
  const planar = PLANAR_SUBSAMPLED.exec(format);
  const turn = displayTurn(video.side_data_list);
  const [hsub, vsub] = planar === null ? [false, false] : [planar[1] !== "440", planar[1] !== "422"];
  const transfer = known(video.color_transfer, ZSCALE_TRANSFERS);
  // The graph turns the frames itself, after reading them in their stored orientation, when autorotate would misplace chroma:
  // zimg (the HDR tone map) reads the chroma location the turn leaves untouched on the frames, and FFmpeg's transpose cannot
  // keep 4:2:2 or 4:4:0, whose odd-sided conversion to 4:4:4 then happens before the graph; and a container crop, which is in
  // stored coordinates, is cropped before the turn.
  const [codedWidth, codedHeight] = [video.width ?? 0, video.height ?? 0];
  const cut = videoContainerCrop(video as Record<string, unknown>, formatName);
  const crop = cut.top + cut.bottom + cut.left + cut.right === 0 ? null
    : `crop=${codedWidth - cut.left - cut.right}:${codedHeight - cut.top - cut.bottom}:${cut.left}:${cut.top}:exact=1`;
  const own = turn.filter !== null && (crop !== null || transfer === "smpte2084" || transfer === "arib-std-b67"
    || (turn.transposed && hsub !== vsub && (codedWidth % 2 === 1 || codedHeight % 2 === 1)));
  const [width, height] = turn.transposed && !own ? [codedHeight, codedWidth] : [codedWidth, codedHeight];
  const odd = planar !== null && (width % 2 === 1 || height % 2 === 1)
    ? { format, alpha: format.startsWith("yuva"), width, height, hsub, vsub, leadX: !own && turn.x, leadY: !own && turn.y }
    : null;
  return {
    transfer, primaries: known(video.color_primaries, ZSCALE_PRIMARIES) ?? "bt709",
    range: video.color_range === "pc" || format.startsWith("yuvj") ? "pc" : "tv", chromaLocation: known(video.chroma_location, CHROMA_LOCATIONS) ?? "left",
    odd, turn: own ? turn.filter : null, crop,
  };
}

/**
 * The input options that put an ISO source on its media timeline.
 * @param facts - The source facts.
 * @returns `-ignore_editlist 1` for ISO, nothing otherwise.
 * @throws {never} Never.
 */
function mediaTimeline(facts: SourceFacts): string[] {
  return facts.iso ? ["-ignore_editlist", "1"] : [];
}

/**
 * The start of the source frame shown at a span's clip start: the last video packet at or before it, read from the span's
 * keyframe on. A span starting on its keyframe starts on a frame.
 * @param source - The downloaded source.
 * @param facts - Its facts.
 * @param entry - The source span.
 * @param run - The lifetime and IO bounds.
 * @returns The frame start, exact; the clip start when no frame starts before it.
 * @throws {Error} When ffprobe fails or answers without the stream's time base.
 */
async function frameStartAt(source: string, facts: SourceFacts, entry: Extract<MiniToolPlanEntry, { kind: "source" }>, run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<[bigint, bigint]> {
  const clip = rational(entry.clipStart);
  const decode = rational(entry.decodeStart);
  if (decode[0] * clip[1] === clip[0] * decode[1]) return clip;
  const conform = entry.conform;
  // One second past the clip start covers packets that B-frame reordering delivers after a later one.
  const until: [bigint, bigint] = [clip[0] + clip[1], clip[1]];
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", ...mediaTimeline(facts), "-select_streams", "v:0",
    "-read_intervals", `${seconds(decode)}%${seconds(until)}`, "-show_entries", "stream=time_base:packet=pts", "-of", "json", source], run)).toString("utf8")) as
    { streams?: { time_base?: string }[]; packets?: { pts?: number }[] };
  const base = /^(\d+)\/(\d+)$/u.exec(answer.streams?.[0]?.time_base ?? "");
  if (base === null) throw new Error("Source span probe has no video time base");
  const [tickNumerator, tickDenominator] = [BigInt(base[1]!), BigInt(base[2]!)];
  let best: bigint | null = null;
  for (const packet of answer.packets ?? []) {
    if (packet.pts === undefined) continue;
    const pts = BigInt(packet.pts);
    // On a conform grid a frame starts at its grid point, the time it is shown from (§7.17 rounding clock row).
    const [at, per] = conform === undefined ? [pts * tickNumerator, tickDenominator] : conformedTime(conform, [pts * tickNumerator, tickDenominator]);
    if (at * clip[1] <= clip[0] * per && (best === null || pts > best)) best = pts;
  }
  if (best === null) return clip;
  return conform === undefined ? [best * tickNumerator, tickDenominator] : conformedTime(conform, [best * tickNumerator, tickDenominator]);
}

/** The inputs and filter graph presenting a window's frames, ending at `[v]`. */
interface WindowGraph { args: string[]; graph: string[]; inputs: number; facts: SourceFacts; clock: bigint }

/** A frame rate as a reduced numerator and denominator. */
type FrameRate = readonly [bigint, bigint];

/**
 * The greatest common divisor.
 * @param left - One integer.
 * @param right - The other.
 * @returns The divisor, non-negative.
 * @throws {never} Never.
 */
function gcd(left: bigint, right: bigint): bigint {
  let [a, b] = [left < 0n ? -left : left, right < 0n ? -right : right];
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * The least common multiple of two positive integers.
 * @param left - One integer.
 * @param right - The other.
 * @returns The multiple.
 * @throws {never} Never.
 */
function lcm(left: bigint, right: bigint): bigint {
  return (left / gcd(left, right)) * right;
}

/**
 * The denominator of an exact value in lowest terms.
 * @param value - The numerator and denominator.
 * @returns The reduced denominator.
 * @throws {never} Never.
 */
function lowestDenominator([numerator, denominator]: readonly [bigint, bigint]): bigint {
  return denominator / gcd(numerator, denominator);
}

/**
 * A frame rate in lowest terms.
 * @param rate - The plan's rate.
 * @returns The reduced rate.
 * @throws {RangeError} When the rate is malformed.
 */
function frameRate(rate: MiniToolPlanExact): FrameRate {
  const [numerator, denominator] = rational(rate);
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

/**
 * The grid slot a frame starting at a time takes: the first slot at or after it (`fps` rounding up).
 * @param time - The time from the window start, exact.
 * @param rate - The grid's rate.
 * @returns The slot.
 * @throws {RangeError} When the time is negative.
 */
function slotAtOrAfter([numerator, denominator]: [bigint, bigint], rate: FrameRate): bigint {
  if (numerator < 0n) throw new RangeError("Presentation entries run forward from the window start");
  const top = numerator * rate[0];
  const bottom = denominator * rate[1];
  return (top + bottom - 1n) / bottom;
}

// FFmpeg evaluates setpts in doubles, which are exact for integers below 2^53; a frame's slot is exact below 2^52.
const EXACT_TICKS = 1n << 52n;
// FFmpeg filter time bases are int rationals: settb clamps a larger denominator to this without an error.
const MAX_TIME_BASE_DENOMINATOR = 2147483647n;

/**
 * The clock on which every source frame time of a window, after its clip start and rate, and every slot of a frame grid
 * is a whole number of ticks, so each frame can be put on its slot exactly.
 * @param entries - The window's entries.
 * @param origin - The window start.
 * @param tick - The source's video time base.
 * @param rate - The grid's rate.
 * @returns Ticks per second.
 * @throws {RangeError} When a time is malformed or the clock is too fine for exact timestamp arithmetic.
 */
function exactClock(entries: readonly MiniToolPlanEntry[], origin: MiniToolPlanExact, tick: [bigint, bigint] | null, rate: FrameRate): bigint {
  let clock = rate[0];
  let reach = 0n;
  for (const entry of entries) {
    clock = lcm(clock, lowestDenominator(minus(span(entry).start, origin)));
    if (entry.kind === "empty") continue;
    if (tick === null) throw new RangeError("A source span needs a video time base");
    const [rateNumerator, rateDenominator] = frameRate(entry.rate);
    const clip = rational(entry.clipStart);
    clock = lcm(clock, lcm(lowestDenominator(tick), lowestDenominator(clip)) * rateNumerator);
    // A conform grid's points are whole ticks (§7.17 rounding clock row).
    if (entry.conform !== undefined) clock = lcm(clock, lcm(lowestDenominator(rational(entry.conform.origin)), lowestDenominator(rational(entry.conform.period))));
    const end = plus(clip, times(minus(entry.displayEnd, entry.displayStart), rational(entry.rate)));
    const ticks = ((end[0] + end[1] - 1n) / end[1] + 1n) * rateDenominator;
    if (ticks > reach) reach = ticks;
  }
  if (reach * clock >= EXACT_TICKS) throw new RangeError("The window's exact clock is too fine for exact timestamps");
  return clock;
}

/**
 * Present a window's entries as frames (§5.4 chunking and chunk time; §7.17 entries): each source span decodes from its
 * keyframe on the media timeline and shows from its clip start at its rate, each derived-empty entry is one composed frame.
 * Without a grid the frames run on a `1/clock` clock from 0, one output frame per presented frame; entries with a conform grid
 * run on an exact clock that holds its points, returned as the graph's `clock`. With a grid each frame
 * is put on the first grid slot at or after its start (§7.17 transition output profile row: output frame k shows the
 * source frame covering k / fps) before the inputs are interleaved, whose microsecond times would otherwise move a frame to
 * the next slot, and a closing frame on the slot at the window end lets the grid that follows keep the last frame.
 * @param entries - The window's entries.
 * @param time - The timescale, or the rate of the frame grid that follows; the frames then run on a `rate⁻¹` time base.
 * @param source - The downloaded source.
 * @param run - The lifetime and IO bounds.
 * @param frame - The chain after a source span's timing, given a unique label prefix and the source's colour facts.
 * @param empty - The source of one composed frame for a derived-empty entry.
 * @returns The inputs and graph.
 * @throws {RangeError} When a time is malformed or the clock is beyond FFmpeg's time base range.
 * @throws {Error} When ffprobe fails.
 */
export async function windowGraph(entries: readonly MiniToolPlanEntry[], time: bigint | FrameRate, source: string, run: Run,
  frame: (label: string, colour: FrameColour) => string, empty: (entry: Extract<MiniToolPlanEntry, { kind: "empty" }>) => string): Promise<WindowGraph> {
  const origin = span(entries[0]!).start;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts"];
  const graph: string[] = [];
  const facts = await sourceFacts(source, run);
  const grid = typeof time === "bigint" ? null : time;
  // Grid points of a conform grid lie between the ticks of the window's own clock, so such a window runs on an exact clock.
  const conformed = entries.some((entry) => entry.kind === "source" && entry.conform !== undefined);
  const clock = grid === null ? (conformed ? exactClock(entries, origin, facts.tick, [time as bigint, 1n]) : time as bigint) : exactClock(entries, origin, facts.tick, grid);
  if (clock > MAX_TIME_BASE_DENOMINATOR) throw new RangeError("The window's clock is beyond FFmpeg's time base range");
  const slot = grid === null ? null : (clock * grid[1]) / grid[0];
  const base = grid === null ? `1/${clock}` : `${grid[1]}/${grid[0]}`;
  /**
   * The timing of a frame placed at a time from the window start: its clock ticks, or its grid slot.
   * @param at - The time from the window start.
   * @returns The filter text.
   * @throws {RangeError} When the time is negative.
   */
  const placed = (at: [bigint, bigint]): string => `settb=${base},setpts=${grid === null ? roundTimes(at, clock) : slotAtOrAfter(at, grid)}`;
  let inputs = 0;
  for (const [at, entry] of entries.entries()) {
    const offset = minus(span(entry).start, origin);
    if (entry.kind === "empty") {
      graph.push(`${empty(entry)},${placed(offset)}[e${at}]`);
      continue;
    }
    // At rate a/b the span shows media [clipStart, clipStart + length·a/b), each frame for its media duration·b/a (§7.17).
    const [rateNumerator, rateDenominator] = rational(entry.rate);
    const [clipNumerator, clipDenominator] = rational(entry.clipStart);
    const clipEnd = plus([clipNumerator, clipDenominator], times(minus(entry.displayEnd, entry.displayStart), [rateNumerator, rateDenominator]));
    // An edit can start inside a source frame (§7.17 timeline row): that frame is kept and shown from clipStart.
    const first = await frameStartAt(source, facts, entry, run);
    args.push(...mediaTimeline(facts), "-seek_timestamp", "1", "-noaccurate_seek", "-ss", seconds(rational(entry.decodeStart)), ...facts.decoder, "-i", source);
    const ticks = `max(round((PTS-${roundTimes([clipNumerator, clipDenominator], clock)})*${rateDenominator}/${rateNumerator})\\,0)+${roundTimes(offset, clock)}`;
    // On a rounding clock each stored frame time snaps to its exact grid point first (§7.17 rounding clock row), then trims.
    const snap = entry.conform === undefined ? null
      : { origin: roundTimes(rational(entry.conform.origin), clock), period: roundTimes(rational(entry.conform.period), clock), first };
    const timing = snap === null ? `trim=start=${seconds(first)}:end=${seconds(clipEnd)},settb=1/${clock},`
      : `settb=1/${clock},setpts=${snap.origin}+floor((PTS-${snap.origin})/${snap.period}+0.5)*${snap.period},trim=start=${seconds(snap.first)}:end=${seconds(clipEnd)},`;
    graph.push(`[${inputs}:v:0]${timing}${slot === null ? `setpts=${ticks}` : `setpts=ceil((${ticks})/${slot})*${slot},settb=${base}`},${frame(`p${at}`, facts.colour)}[e${at}]`);
    inputs += 1;
  }
  // interleave ends the stream at its last frame's start, so a grid after it never gives that frame its slot and repeats
  // the one before; the closing frame takes the slot at the window end, which the grid's trim then drops.
  const labels = entries.map((_entry, at) => `[e${at}]`);
  if (grid !== null) {
    const last = span(entries[entries.length - 1]!);
    graph.push(`${empty({ kind: "empty", fill: "black", window: last })},${placed(minus(last.end, origin))}[end]`);
    labels.push("[end]");
  }
  graph.push(`${labels.join("")}interleave=nb_inputs=${labels.length},settb=${base}[v]`);
  return { args, graph, inputs, facts, clock };
}

/**
 * The video encoder, frame timing and muxer of a target: H.264 MP4 on the presentation track clock, or a VP9 WebM split
 * output with its alpha (§91 D4-4); the next frame's start ends each frame and the window end ends the last.
 * @param target - The target.
 * @param clock - The timescale.
 * @param end - The window end in ticks of the encoder time base.
 * @param tick - The encoder time base's numerator over `clock`, 1 unless a frame rate such as 1001/30000 is the time base.
 * @returns The encoder and timing arguments, and the muxer arguments.
 * @throws {never} Never.
 */
export function videoOutput(target: MiniToolPlanTarget, clock: bigint, end: bigint, tick = 1n): { video: string[]; muxer: string[] } {
  const timing = ["-fps_mode", "passthrough", "-enc_time_base:v", `${tick}/${clock}`, "-bsf:v", `setts=duration=if(eq(NEXT_PTS\\,NOPTS)\\,${end}-PTS\\,NEXT_PTS-PTS)`];
  if (target.format === "webm-vp9") {
    const alpha = target.alpha === "straight";
    return { video: ["-c:v", "libvpx-vp9", "-pix_fmt", alpha ? "yuva420p" : "yuv420p", "-crf", String(target.crf), "-b:v", "0", "-deadline", "good", "-row-mt", "1",
      ...(alpha ? ["-auto-alt-ref", "0"] : []), ...timing], muxer: ["-f", "webm"] };
  }
  return { video: ["-c:v", "libx264", "-preset", target.preset, "-crf", String(target.crf), "-bf", "0", "-pix_fmt", "yuv420p", ...timing, "-video_track_timescale", String(clock)],
    muxer: ["-movflags", "+faststart", "-f", "mp4"] };
}

/**
 * The audio encoder of a target: AAC in MP4, Opus in a VP9 WebM split output (§7.17 segment row).
 * @param target - The target.
 * @returns The audio mapping and encoder arguments.
 * @throws {never} Never.
 */
function audioOutput(target: MiniToolPlanTarget): string[] {
  return target.format === "webm-vp9" ? ["-map", "[a]", "-c:a", "libopus", "-ar", "48000"] : AAC;
}

/**
 * A transition output profile as the target its chunks are encoded to (§7.17 transition output profile row): H.264 MP4 without alpha, VP9
 * WebM with straight alpha, the profile's quality and BT.709.
 * @param profile - The profile.
 * @param target - The chunk's own target, whose picture placement is kept; a whole-frame picture when absent.
 * @returns The encode target.
 * @throws {never} Never.
 */
function profileTarget(profile: MiniToolPlanTransitionProfile, target?: MiniToolPlanTarget): MiniToolPlanTarget {
  return { width: profile.width, height: profile.height, displayRect: target?.displayRect ?? null, colorMatrix: target?.colorMatrix ?? "bt709", toneMap: target?.toneMap ?? "none",
    alpha: profile.alpha ? "straight" : "none", crf: profile.encode.crf, preset: profile.encode.preset, format: profile.codec === "vp9" ? "webm-vp9" : "mp4-h264" };
}

/**
 * The frames of a window on a transition profile's constant-rate grid (§7.17 transition output profile row: output frame k shows the source
 * frame covering k / fps): `fps` with upward rounding assigns each frame the first output slot at or after its start, and
 * the last frame is held until exactly `count` frames are out.
 * @param profile - The profile.
 * @param count - The chunk's output frame count.
 * @returns The filter chain text, on the time base 1/fps.
 * @throws {RangeError} When the frame rate is malformed.
 */
function profileGrid(profile: MiniToolPlanTransitionProfile, count: number): string {
  const [numerator, denominator] = rational(profile.fps);
  return `fps=fps=${numerator}/${denominator}:round=up,tpad=stop_mode=clone:stop=${count},trim=end_frame=${count}`;
}

/**
 * The rate of the frame grid a window's frames go on: a transition profile's, or a model input's resample grid; a reversed
 * stream is re-timed frame by frame instead.
 * @param recipe - The chunk, model-input or segment recipe.
 * @returns The rate, or null without a grid.
 * @throws {RangeError} When a resample grid's rate is not a whole number of frames per second.
 */
function gridRate(recipe: Extract<PresentationRecipe, { kind: "chunk_encode" | "prepare_model_input" }> | SegmentRecipe): FrameRate | null {
  if (recipe.kind === "chunk_encode" && recipe.profile !== undefined) return frameRate(recipe.profile.fps);
  if (recipe.kind !== "prepare_model_input" || recipe.grid?.mode !== "resample" || recipe.order === "reverse") return null;
  if (!Number.isInteger(recipe.grid.rate)) throw new RangeError("A resample grid runs at a whole frame rate");
  return [BigInt(recipe.grid.rate), 1n];
}

/**
 * Render a window into its target (§5.4; §7.17 segment row): the window's frames with the target picture, opening with a
 * keyframe; a model input or a segment adds its interval's audio (§5.3, §91 D3-4, D4-4), a chunk has none. A transition
 * chunk is resampled to its profile's frame grid and encoded with the profile, so its codec headers equal the window chunks'.
 * @param recipe - The chunk, model-input or segment recipe.
 * @param source - The downloaded source.
 * @param output - The file to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When a time is malformed.
 * @throws {Error} When FFmpeg fails.
 */
async function renderWindow(recipe: Extract<PresentationRecipe, { kind: "chunk_encode" | "prepare_model_input" }> | SegmentRecipe, source: string, output: string, run: Run): Promise<void> {
  const { entries } = recipe;
  const profile = recipe.kind === "chunk_encode" ? recipe.profile : undefined;
  const target = profile === undefined ? recipe.target : profileTarget(profile, recipe.target);
  const clock = BigInt(recipe.timescale);
  const transparent = target.format === "webm-vp9" && target.alpha === "straight";
  // Black: a transparent fill packs to black colour and black alpha; a VP9 output with alpha keeps it transparent.
  const window = await windowGraph(entries, gridRate(recipe) ?? clock, source, run, (label, colour) => picture(target, label, colour),
    (entry) => `color=c=black${transparent && entry.fill === "transparent" ? "@0" : ""}:s=${target.width}x${target.height}:r=1:d=1,` +
      `format=${transparent ? "yuva420p" : "yuv420p"},setsar=1,${BT709_TAGS}`);
  const { args, graph } = window;
  const audio = recipe.kind !== "chunk_encode" && recipe.audio !== null && window.facts.audio ? audioOf(window.inputs, recipe.audio) : null;
  if (audio !== null) {
    args.push(...audio.args, source);
    graph.push(audio.graph);
  }
  let encode: { video: string[]; muxer: string[] };
  // A transition chunk is as many frames as the output frames it covers on the profile's grid, not its source frames.
  const count = recipe.kind === "chunk_encode" && recipe.frames !== undefined ? recipe.frames.end - recipe.frames.start : recipe.window.end - recipe.window.start;
  if (recipe.kind === "prepare_model_input" && (recipe.order === "reverse" || recipe.grid !== undefined)) {
    encode = modelInputTiming(recipe, graph, clock, count, target);
  } else if (profile === undefined) encode = videoOutput(target, window.clock, roundTimes(minus(span(entries[entries.length - 1]!).end, span(entries[0]!).start), window.clock));
  else {
    const [tick, base] = rational(profile.timeBase);
    // The window's graph ends at [v]; the grid takes it from there (the audio chain, absent for a chunk, never follows it).
    graph.push(`${graph.pop()!.replace(/\[v\]$/u, "[w]")};[w]${profileGrid(profile, count)}[v]`);
    encode = videoOutput(target, base, BigInt(count), tick);
  }
  args.push("-filter_complex", graph.join(";"), "-map", "[v]", ...encode.video, ...(audio === null ? ["-an"] : audioOutput(target)), ...encode.muxer, output);
  await runPlanCommand("ffmpeg", args, run);
}

/**
 * Re-time a model input's frames (execution design §10.2, §10.4): a reversed tracking clip plays the window's frames backwards
 * from 0, one window frame step each; a `frames` grid keeps every frame and stamps frame N at N / rate; a `resample` grid shows
 * at slot j the frame covering j / rate (the window graph already put each frame on its slot) and holds the last frame to
 * exactly the grid's count. Rewrites the graph's last chain to end on the re-timed `[v]`.
 * @param recipe - The model input recipe.
 * @param graph - The window graph, whose last chain ends on `[v]`.
 * @param clock - The window's timescale.
 * @param count - The window's frame count.
 * @param target - The encode target.
 * @returns The encoder and muxer arguments for the re-timed frames.
 * @throws {never} Never.
 */
function modelInputTiming(recipe: Extract<PresentationRecipe, { kind: "prepare_model_input" }>, graph: string[], clock: bigint, count: number, target: MiniToolPlanTarget): { video: string[]; muxer: string[] } {
  const relabel = (chain: string): void => { graph.push(`${graph.pop()!.replace(/\[v\]$/u, "[w]")};[w]${chain}[v]`); };
  if (recipe.order === "reverse") {
    const end = roundTimes(minus(span(recipe.entries[recipe.entries.length - 1]!).end, span(recipe.entries[0]!).start), clock);
    const step = end / BigInt(count) > 0n ? end / BigInt(count) : 1n;
    relabel(`reverse,setpts=N*${step}`);
    if (recipe.grid === undefined) return videoOutput(target, clock, step * BigInt(count));
  }
  const grid = recipe.grid!;
  if (grid.mode === "frames") {
    const base = 90000n;
    relabel(`settb=1/${base},setpts=round(N*${base}/${grid.rate})`);
    return videoOutput(target, base, BigInt(Math.round((grid.frameCount * Number(base)) / grid.rate)));
  }
  relabel(`fps=fps=${grid.rate}:round=up,tpad=stop_mode=clone:stop=${grid.frameCount},trim=end_frame=${grid.frameCount}`);
  return videoOutput(target, BigInt(grid.rate), BigInt(grid.frameCount));
}

/**
 * Refuse chunks whose video codec headers differ (§5.4): a stream copy would join incompatible streams. The
 * headers are the codec, profile, size, pixel format and the codec's extradata (H.264 avcC with its SPS and PPS).
 * @param chunks - The downloaded chunk files.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing when every chunk has the first one's headers.
 * @throws {Error} When a chunk's headers differ or ffprobe fails.
 */
async function sameCodecHeaders(chunks: readonly string[], run: Run): Promise<void> {
  let first: string | null = null;
  for (const chunk of chunks) {
    const headers = JSON.stringify(JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,profile,width,height,pix_fmt,extradata", "-show_data", "-of", "json", chunk], run)).toString("utf8")).streams);
    if (first === null) first = headers;
    else if (headers !== first) throw new Error("Stitch chunks have different codec headers");
  }
}

/**
 * The lip-sync result's audio (§7.17 stitch row, §97 D22-3): every person's stem from 0, summed sample by sample without
 * normalising, padded or cut to the chunks' length.
 * @param stems - The downloaded stems.
 * @param chunks - The stitch's chunks, whose durations add up to the result.
 * @returns The input arguments (each stem opened after the concat input) and the chain ending at `[a]`.
 * @throws {RangeError} When a duration is malformed.
 */
function stemMix(stems: readonly string[], chunks: readonly { duration: MiniToolPlanExact }[]): { args: string[]; graph: string } {
  const samples = roundTimes(chunks.reduce<[bigint, bigint]>((sum, chunk) => plus(sum, rational(chunk.duration)), [0n, 1n]), 48000n);
  const labels = stems.map((_stem, at) => `[s${at}]`);
  const heads = stems.map((_stem, at) => `[${at + 1}:a:0]aresample=48000,asetpts=PTS-STARTPTS${labels[at]}`);
  const mix = stems.length === 1 ? "anull" : `amix=inputs=${stems.length}:normalize=0:duration=longest`;
  return { args: stems.flatMap((stem) => ["-i", stem]), graph: [...heads, `${labels.join("")}${mix},apad=whole_len=${samples},atrim=end_sample=${samples}[a]`].join(";") };
}

/**
 * Join the chunks by stream copy (§5.4 stitching): each chunk is placed for its plan duration, and the source's interval audio,
 * when the recipe names one, is encoded once as AAC at 48 kHz.
 * @param recipe - The stitch recipe.
 * @param files - The downloaded inputs by id.
 * @param directory - The run's directory.
 * @param output - The MP4 to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When an input is missing or FFmpeg fails.
 */
async function stitch(recipe: MiniToolPlanStitch, files: ReadonlyMap<string, string>, directory: string, output: string,
  run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<void> {
  await sameCodecHeaders(recipe.chunks.map((chunk) => local(files, chunk.inputId)), run);
  const list = join(directory, "stitch.txt");
  await writeFile(list, recipe.chunks.map((chunk) => `file '${local(files, chunk.inputId)}'\nduration ${seconds(rational(chunk.duration))}\n`).join(""));
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts", "-f", "concat", "-safe", "0", "-i", list];
  const source = local(files, recipe.inputId);
  let audio: { args: string[]; graph: string } | null = null;
  if (recipe.audio !== null && "kind" in recipe.audio) audio = stemMix(recipe.audio.inputs.map((id) => local(files, id)), recipe.chunks);
  else if (recipe.audio !== null && (await sourceFacts(source, run)).audio) {
    const interval = audioOf(1, recipe.audio);
    audio = interval === null ? null : { args: [...interval.args, source], graph: interval.graph };
  }
  if (audio !== null) args.push(...audio.args, "-filter_complex", audio.graph);
  const webm = recipe.target.format === "webm-vp9";
  args.push("-map", "0:v:0", "-c:v", "copy", ...(audio === null ? ["-an"] : audioOutput(recipe.target)), ...(webm ? ["-f", "webm"] : ["-movflags", "+faststart", "-f", "mp4"]), output);
  await runPlanCommand("ffmpeg", args, run);
}

/**
 * An exact time as signed ticks of a window's clock from the window's start, rounded to the nearest tick.
 * @param time - The presentation time.
 * @param origin - The window's start.
 * @param clock - The timescale.
 * @returns The ticks.
 * @throws {RangeError} When a time is malformed.
 */
function ticksFrom(time: MiniToolPlanExact, origin: MiniToolPlanExact, clock: bigint): bigint {
  const [numerator, denominator] = minus(time, origin);
  return numerator < 0n ? -roundTimes([-numerator, denominator], clock) : roundTimes([numerator, denominator], clock);
}

/**
 * Composite an expand's backgrounds over a window (§7.17 model_composite row; execution design §8, §8.1; §97 D20-2, D20-3), on
 * the window's own clock from 0 and opening with a keyframe as a segment does (the erase composite is in `model-recipes.ts`).
 * Expand lays each background over the target from its
 * window's start by its own PTS (cropped to the product ROI and scaled to the target first when it is a whole model frame),
 * fades each later background in across its overlap with the one before by presentation time, and places the source at its
 * frozen rectangle on top. A background is SDR and decoded with its own colour tags ({@link modelResultDecode}). The audio is the stitch's.
 * @param recipe - The composite recipe.
 * @param files - The downloaded inputs by id.
 * @param output - The file to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When a time is malformed or the plan's or a background's matrix has no decode value.
 * @throws {Error} When an input is missing or FFprobe or FFmpeg fails.
 */
async function compositeWindow(recipe: MiniToolPlanExpandComposite, files: ReadonlyMap<string, string>, output: string, run: Run): Promise<void> {
  const { entries, target } = recipe;
  const clock = BigInt(recipe.timescale);
  const origin = span(entries[0]!).start;
  const { rect } = placement(target);
  const sourceTarget = { ...target, width: rect.width, height: rect.height, displayRect: null };
  const window = await windowGraph(entries, clock, local(files, recipe.inputId), run, (label, colour) => picture(sourceTarget, label, colour),
    () => `color=c=black:s=${sourceTarget.width}x${sourceTarget.height}:r=1:d=1,format=yuv420p,setsar=1,${BT709_TAGS}`);
  const { args, graph } = window;
  let inputs = window.inputs;
  /**
   * Open a bound model output as the next input and place its frames on the window's clock from a presentation time.
   * @param inputId - The output.
   * @param from - The presentation time its first frame shows at.
   * @param chain - The filters before its timing.
   * @returns The chain from the input to its timing.
   * @throws {Error} When the input was not downloaded.
   */
  const placed = (inputId: string, from: MiniToolPlanExact, chain: string): string => {
    args.push("-i", local(files, inputId));
    // On the output's own time base: a model output at a higher rate than the window's clock keeps every frame's PTS.
    return `[${inputs++}:v:0]${chain},setpts=PTS-STARTPTS+(${ticksFrom(from, origin, clock)}/${clock})/TB`;
  };
  const decodes = await Promise.all(recipe.backgrounds.map((background) => probeModelResultDecode(local(files, background.inputId), run)));
  graph.push("[v]split[sv][sc]", `[sc]pad=${target.width}:${target.height}:${rect.x}:${rect.y}:color=black[b0]`);
  recipe.backgrounds.forEach((background, at) => {
    const crop = background.crop === undefined ? "" : `crop=${background.crop.width}:${background.crop.height}:${background.crop.x}:${background.crop.y}:exact=1,`;
    const previous = recipe.backgrounds[at - 1];
    const overlap = previous === undefined ? null : minus(previous.window.end, background.window.start);
    // On the background's own timeline from its first frame, so a chunk opening inside the overlap never starts the fade before 0.
    const fade = overlap === null || overlap[0] <= 0n ? "" : `,setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:st=0:d=${seconds(overlap)}:alpha=1`;
    graph.push(`${placed(background.inputId, background.window.start,
      `${crop}scale=${target.width}:${target.height}:${decodes[at]!}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,${BT709_TAGS}${fade}`)}[g${at}]`,
    `[b${at}][g${at}]overlay[b${at + 1}]`);
  });
  graph.push(`[b${recipe.backgrounds.length}][sv]overlay=${rect.x}:${rect.y}[o]`);
  // An overlay goes on after its main input ends while a model output still has frames; the chunk is the window's frames.
  graph.push(`[o]trim=end_frame=${recipe.window.end - recipe.window.start}[c]`);
  const { video, muxer } = videoOutput(target, clock, roundTimes(minus(span(entries[entries.length - 1]!).end, origin), clock));
  args.push("-filter_complex", graph.join(";"), "-map", "[c]", ...video, "-an", ...muxer, output);
  await runPlanCommand("ffmpeg", args, run);
}

/**
 * Join a transition's chunks by stream copy and lay both clips' audio under them (§7.17 stitch and transition output profile rows; §97
 * D15-7, D16-1): each clip's audio over its own span, a clip without audio as silence; a Cut joins the two directly and
 * a transition crosses them over the window with linear gains (`acrossfade c1=tri:c2=tri`), as the preview's two gains do.
 * A clip's length is its audio interval; a silent clip's is what the chunks leave of the timeline.
 * @param recipe - The transition stitch.
 * @param files - The downloaded inputs by id.
 * @param directory - The run's directory.
 * @param output - The file to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {Error} When the chunks' codec headers differ, an input is missing or FFmpeg fails.
 */
async function transitionStitch(recipe: MiniToolPlanTransitionStitch, files: ReadonlyMap<string, string>, directory: string, output: string, run: Run): Promise<void> {
  const chunks = recipe.chunks.map((chunk) => local(files, chunk.inputId));
  await sameCodecHeaders(chunks, run);
  const list = join(directory, "stitch.txt");
  await writeFile(list, recipe.chunks.map((chunk, at) => `file '${chunks[at]}'\nduration ${seconds(rational(chunk.duration))}\n`).join(""));
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts", "-f", "concat", "-safe", "0", "-i", list];
  const total = recipe.chunks.reduce<[bigint, bigint]>((sum, chunk) => plus(sum, rational(chunk.duration)), [0n, 1n]);
  const [fpsNumerator, fpsDenominator] = rational(recipe.profile.fps);
  const overlap: [bigint, bigint] = recipe.crossfade === null ? [0n, 1n] : [BigInt(recipe.crossfade.frameCount) * fpsDenominator, fpsNumerator];
  const facts = await Promise.all(recipe.clips.map(async (clip) => (clip.audio === null ? null : sourceFacts(local(files, clip.inputId), run))));
  const heard = recipe.clips.map((clip, at) => (facts[at]?.audio === true ? clip.audio : null));
  const lengths = heard.map((audio) => (audio === null ? null : minusQ(rational(audio.end), rational(audio.start))));
  const graph: string[] = [];
  let inputs = 1;
  if (lengths.some((length) => length !== null)) {
    recipe.clips.forEach((clip, at) => {
      const other = lengths[1 - at];
      const length = lengths[at] ?? minusQ(plus(total, overlap), other!);
      const samples = roundTimes(length, 48000n);
      const audio = heard[at] === null ? null : audioOf(inputs, heard[at]!, `c${at}`);
      // Each clip's audio is stamped by its sample count: apad's padding after a range with no samples carries no timestamps,
      // and concat would then lay the next clip's audio on top of it. Both clips meet in stereo, the layout the preview plays:
      // concat and acrossfade take the first input's layout, so a silent or mono first clip would fold the second to mono. A
      // mono clip plays on both channels at its own level, as the Web Audio up-mix the preview goes through does.
      if (audio === null) graph.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[d${at}]`);
      else {
        args.push(...audio.args, local(files, clip.inputId));
        inputs += 1;
        graph.push(audio.graph, `[c${at}]${facts[at]!.mono ? "pan=stereo|c0=c0|c1=c0" : "aformat=channel_layouts=stereo"},apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB[d${at}]`);
      }
    });
    graph.push(recipe.crossfade === null ? "[d0][d1]concat=n=2:v=0:a=1[a]" : `[d0][d1]acrossfade=ns=${roundTimes(overlap, 48000n)}:c1=tri:c2=tri[a]`);
  }
  const target = profileTarget(recipe.profile);
  args.push(...(graph.length === 0 ? [] : ["-filter_complex", graph.join(";")]), "-map", "0:v:0", "-c:v", "copy",
    ...(graph.length === 0 ? ["-an"] : audioOutput(target)), ...(target.format === "webm-vp9" ? ["-f", "webm"] : ["-movflags", "+faststart", "-f", "mp4"]), output);
  await runPlanCommand("ffmpeg", args, run);
}

/** The headless-gl renderer of the MiniToolContainerGl image (the gl variant of packages/ingest/Dockerfile), a separate program. */
const GL_RENDERER = "/app/gl-renderer/render.mjs";

/**
 * Render one chunk of a transition's overlap window (§7.17 transition_window row; §5.4; transitions render DD): each clip's
 * frames are presented on the profile's frame grid as RGBA at the output size, in the clip's `fit` rectangle (`transitionFitRect`, the preview's `contain`);
 * the separate headless-gl renderer draws output frame k at progress (k − startFrame) / frameCount with the same
 * `gl-transition` call and pinned `gl-transitions` shader as the preview; FFmpeg encodes the frames with the profile,
 * opening with an IDR, so the chunk's codec headers equal the profile's `chunk_encode` chunks'.
 * @param recipe - The window chunk.
 * @param files - The downloaded inputs by id.
 * @param directory - The run's directory.
 * @param output - The file to write.
 * @param run - The lifetime and IO bounds.
 * @returns Nothing once written.
 * @throws {RangeError} When a time is malformed.
 * @throws {Error} When an input is missing, the renderer or FFmpeg fails.
 */
async function renderTransitionWindow(recipe: MiniToolPlanTransitionWindow, files: ReadonlyMap<string, string>, directory: string, output: string, run: Run): Promise<void> {
  const { profile, frames, window } = recipe;
  const { width, height } = profile;
  const count = frames.end - frames.start;
  const [tick, base] = rational(profile.timeBase);
  const fill = `black@${profile.alpha ? 0 : 1}`;
  const decoded = await Promise.all(recipe.clips.map(async (clip, at) => {
    // Each clip is decoded with its own plan's matrix and tone mapped as its own chunk_encode would be (§97 D23-4).
    // The chunk's own conversion to limited-range BT.709 first, then full-range RGBA for the renderer, so the window meets
    // the chunk_encode chunks with no colour jump; a transparent profile keeps each clip's alpha through it.
    /**
     * The clip's conversion for one span of the window graph.
     * @param label - The span's label prefix, unique within the graph.
     * @param colour - The source's colour facts.
     * @returns The filter chain text.
     * @throws {RangeError} When the plan matrix has no decode value.
     */
    const convert = (label: string, colour: FrameColour): string =>
      `${decodedPicture(clip, clip.fit.width, clip.fit.height, colour, label, { format: profile.alpha ? "yuva444p" : "yuv444p", bt709: true }, profile.alpha)}` +
      ",scale=in_color_matrix=bt709:in_range=tv:out_range=pc";
    const window = await windowGraph(clip.entries, frameRate(profile.fps), local(files, clip.inputId), run,
      (label, colour) => `${convert(label, colour)},format=rgba,pad=${width}:${height}:${clip.fit.x}:${clip.fit.y}:color=${fill},setsar=1`,
      (entry) => `color=c=black${entry.fill === "transparent" ? "@0" : ""}:s=${width}x${height}:r=1:d=1,format=rgba`);
    const file = join(directory, `transition-${at}.rgba`);
    await runPlanCommand("ffmpeg", [...window.args, "-filter_complex", `${window.graph.join(";").replace(/\[v\]$/u, "[w]")};[w]${profileGrid(profile, count)},format=rgba[v]`,
      "-map", "[v]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", file], run);
    return file;
  }));
  const rendered = join(directory, "transition-out.rgba");
  const request = join(directory, "transition-request.json");
  await writeJson(request, { width, height, frameCount: count, transition: recipe.transition, from: decoded[0], to: decoded[1], output: rendered,
    progress: Array.from({ length: count }, (_unused, at) => (frames.start + at - window.startFrame) / window.frameCount) });
  await runPlanCommand("node", [GL_RENDERER, request], run);
  const target = profileTarget(profile);
  const { video, muxer } = videoOutput(target, base, BigInt(count), tick);
  await runPlanCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`,
    "-framerate", `${base}/${tick}`, "-i", rendered, "-vf", `scale=in_range=pc:out_color_matrix=bt709:out_range=tv,${subsampledAt(width, height, profile.alpha ? "yuva420p" : "yuv420p")},setsar=1,${BT709_TAGS}`,
    ...video, "-an", ...muxer, output], run);
}

/**
 * Copy the carrier (§7.17 copy_carrier row): the video packets as they are with the plan's matrix tag; the audio copied,
 * encoded to AAC 48 kHz over the stitch's audio entries (§4.2), or left out.
 * @param recipe - The copy recipe.
 * @param source - The downloaded source.
 * @param output - The MP4 to write.
 * @param bounds - The lifetime and frozen process IO bounds for the copy.
 * @param bounds.signal - The lifetime.
 * @param bounds.limits - The bounds.
 * @param run - The lifetime and IO bounds for reading the source facts.
 * @returns Nothing once written.
 * @throws {Error} When FFmpeg fails.
 */
async function copyCarrier(recipe: Extract<PresentationRecipe, { kind: "copy_carrier" }>, source: string, output: string,
  bounds: { signal: AbortSignal; limits: { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number } }, run: Run): Promise<void> {
  const { audio } = recipe;
  if (audio === null || audio.kind === "copy") { await copyWithMatrixTag(source, output, recipe.colorMatrix, recipe.origin, bounds, audio === null ? null : "copy"); return; }
  const { kind: _kind, ...entries } = audio;
  await copyWithMatrixTag(source, output, recipe.colorMatrix, recipe.origin, bounds, (await sourceFacts(source, run)).audio ? audioOf(1, entries) : null);
}

/**
 * A bound input's downloaded file.
 * @param files - The downloaded inputs by id.
 * @param inputId - The input.
 * @returns Its path.
 * @throws {Error} When it was not downloaded.
 */
export function local(files: ReadonlyMap<string, string>, inputId: string): string {
  const file = files.get(inputId);
  if (file === undefined) throw new Error("Presentation recipe names an input that was not downloaded");
  return file;
}

/**
 * Render a still frame (§7.17 frame row and orientation-and-geometry row; §4.3): a source entry decodes from its decodeStart and takes the
 * frame shown at its clip start, upright, tone mapped when the plan says so, decoded with the plan's matrix and scaled to the
 * display geometry; a derived-empty entry is composed in its fill. The PNG is 8 or 16 bits per channel, RGBA when alpha is
 * kept, and cropped to the display crop when there is one.
 * @param recipe - The frame recipe.
 * @param source - The downloaded source.
 * @param output - The PNG to write.
 * @param run - The lifetime and IO bounds.
 * @returns The PNG's size.
 * @throws {RangeError} When the plan matrix has no decode value.
 * @throws {Error} When FFmpeg fails or the PNG is incomplete.
 */
async function renderFrame(recipe: FrameRecipe, source: string, output: string,
  run: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<{ width: number; height: number }> {
  const { entry, target, crop } = recipe;
  const keep = target.alpha === "straight";
  const pixel = keep ? (target.pngBitDepth === 16 ? "rgba64be" : "rgba") : (target.pngBitDepth === 16 ? "rgb48be" : "rgb24");
  const cropped = crop === undefined ? "" : `,crop=${crop.rect.width}:${crop.rect.height}:${crop.rect.x}:${crop.rect.y}:exact=1`;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-copyts"];
  let graph: string;
  if (entry.kind === "empty") {
    graph = `color=c=black${keep && entry.fill === "transparent" ? "@0" : ""}:s=${target.width}x${target.height}:r=1:d=1,format=${pixel}${cropped}[v]`;
  } else {
    const facts = await sourceFacts(source, run);
    const first = await frameStartAt(source, facts, entry, run);
    args.push(...mediaTimeline(facts), "-seek_timestamp", "1", "-noaccurate_seek", "-ss", seconds(rational(entry.decodeStart)), ...facts.decoder, "-i", source);
    graph = `[0:v:0]trim=start=${seconds(first)},${decodedPicture(target, target.width, target.height, facts.colour, "f", { format: pixel }, keep)}${cropped}[v]`;
  }
  await runPlanCommand("ffmpeg", [...args, "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", "-c:v", "png", "-f", "image2", output], run);
  const size = pngSize(new Uint8Array(await readFile(output)));
  if (size === null) throw new Error("The frame recipe produced no complete PNG");
  return size;
}

/**
 * Run the pinned detector process on raw BGR frames (the separate Python process, as the source-facts analyses run it).
 * @param kind - The detector.
 * @param profile - Its frozen profile.
 * @param frames - The geometry and count of the frames, and the FFmpeg arguments that write them to stdout.
 * @param frames.width - Their width.
 * @param frames.height - Their height.
 * @param frames.count - How many there are.
 * @param frames.args - The FFmpeg arguments.
 * @param directory - The run's directory.
 * @param signal - The lifetime.
 * @param limits - The frozen IO bounds.
 * @returns The detector's JSON object.
 * @throws {Error} When the detector, its input or its JSON fails.
 */
export async function detect(kind: "people" | "scene_cuts" | "faces", profile: unknown, frames: { width: number; height: number; count: number; args: string[] }, directory: string,
  signal: AbortSignal, limits: PlanLimits): Promise<Record<string, unknown>> {
  const path = join(directory, "analysis-request.json");
  await writeJson(path, { kind, width: frames.width, height: frames.height, expectedFrameCount: frames.count, profile });
  const answer: unknown = JSON.parse(Buffer.from(await runAnalysisPipeline({
    decoder: { program: "ffmpeg", args: frames.args }, processor: { program: "python3", args: ["/app/analysis-runtime.py", path] },
    width: frames.width, height: frames.height, expectedFrameCount: frames.count, signal,
    limits: { stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes },
  })).toString("utf8"));
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw new TypeError("Expected a complete detector object");
  return answer as Record<string, unknown>;
}

/**
 * Store JSON facts as text without allowing a string to mimic SVG bytes.
 * @param output - The file.
 * @param value - The value.
 * @returns Nothing once written.
 * @throws {Error} When writing fails.
 */
export async function writeJson(output: string, value: unknown): Promise<void> {
  await writeFile(output, JSON.stringify(value).replace(/</g, "\\u003c"));
}

/**
 * Detect people on the anchor's frame (§7.17 people anchor row, §91 D4-5): the frame is rendered upright at the target size,
 * and the JSON gives the candidates in that display geometry, with no anchor (the accepted record holds it, §93 D5-8).
 * @param recipe - The people recipe.
 * @param source - The downloaded source.
 * @param output - The JSON to write.
 * @param request - The run's directory, lifetime and bounds.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {Error} When rendering, detection or writing fails.
 */
async function detectPeople(recipe: PeopleRecipe, source: string, output: string, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { width, height } = recipe.target;
  const anchor = join(request.directory, "people-anchor.png");
  await renderFrame({ kind: "frame", inputId: recipe.inputId, entry: recipe.entry, target: recipe.target }, source, anchor, run);
  const result = await detect("people", recipe.profile, { width, height, count: 1,
    args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-i", anchor, "-map", "0:v:0", "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"] },
  request.directory, request.signal, request.limits);
  await writeJson(output, { schemaVersion: 1, kind: "people", coordinateSpace: "display", width, height, candidates: readYuNetFaces(result.faces, { width, height }, true) });
}

/**
 * Detect scene cuts over a window (§7.17 scene_cuts row, §91 D4-5): the window's frames are presented in display geometry,
 * one per presented frame, and each cut is recorded by its presentation ordinal (§93 D5-8).
 * @param recipe - The scene_cuts recipe.
 * @param source - The downloaded source.
 * @param output - The JSON to write.
 * @param request - The run's directory, lifetime and bounds.
 * @param run - The lifetime and IO bounds of one command.
 * @returns Nothing once written.
 * @throws {RangeError} When the plan matrix has no decode value.
 * @throws {Error} When rendering, detection or writing fails.
 */
async function detectScenes(recipe: SceneRecipe, source: string, output: string, request: PresentationRecipeRequest, run: Run): Promise<void> {
  const { width, height } = recipe.target;
  const window = await windowGraph(recipe.entries, BigInt(recipe.timescale), source, run,
    (label, colour) => `${decodedPicture(recipe.target, width, height, colour, label, { format: "bgr24" })},setsar=1,sidedata=mode=delete:type=DISPLAYMATRIX`,
    () => `color=c=black:s=${width}x${height}:r=1:d=1,format=bgr24,setsar=1`);
  const count = recipe.window.end - recipe.window.start;
  const result = await detect("scene_cuts", recipe.profile, { width, height, count,
    args: [...window.args, "-filter_complex", window.graph.join(";"), "-map", "[v]", "-fps_mode", "passthrough", "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"] },
  request.directory, request.signal, request.limits);
  const ordinals = Array.from({ length: count }, (_unused, at) => ({ frameIndex: recipe.window.start + at, pts: (recipe.window.start + at) / recipe.timescale }));
  await writeJson(output, { schemaVersion: 1, kind: "scene_cuts",
    cuts: readSceneCutObservations(result.cuts, ordinals).map((cut) => ({ ordinal: cut.frameIndex, detectionScore: cut.detectionScore })) });
}

/** The bounds and lifetime an output is read back with. */
type ReadBack = Pick<PresentationRecipeRequest, "signal" | "limits">;

/**
 * Read back the media numbers of a written video output.
 * @param output - The written file.
 * @param request - The lifetime and IO bounds.
 * @param kind - The recipe kind, for the failure message.
 * @returns Its width, height and duration.
 * @throws {Error} When ffprobe fails or the output has no complete video metadata.
 */
export async function readVideoMetadata(output: string, request: ReadBack, kind: string): Promise<{ width: number; height: number; durationSeconds: number }> {
  const metadata = await readMediaMetadata(output, request);
  if (metadata.width === null || metadata.height === null || metadata.durationSeconds === null) throw new Error(`The ${kind} recipe produced no complete video metadata`);
  return { width: metadata.width, height: metadata.height, durationSeconds: metadata.durationSeconds };
}

/**
 * Read back the media numbers of a written output.
 * @param output - The written file.
 * @param request - The lifetime and IO bounds.
 * @returns What ffprobe reads of it.
 * @throws {Error} When ffprobe fails.
 */
export async function readMediaMetadata(output: string, request: ReadBack): Promise<{ width: number | null; height: number | null; durationSeconds: number | null }> {
  return pickMediaMetadata(readProbeOutput((await runPlanCommand("ffprobe", probeArgs(output, "own-file"),
    { signal: request.signal, stdoutBytes: request.limits.probeStdoutBytes, stderrTailBytes: request.limits.stderrTailBytes })).toString("utf8")));
}

/**
 * Run one presentation recipe and read back what it wrote.
 * @param request - The recipe, its files and lifetime.
 * @returns The output's media numbers, and for a packed stitch its packing geometry (§91 D3-3; the DO writes the manifest).
 * @throws {Error} When a process fails or the output has no complete video metadata.
 */
export async function executePresentationRecipe(request: PresentationRecipeRequest): Promise<MediaOfOutput> {
  request.signal.throwIfAborted();
  const { inputs, output, directory, signal, limits } = request;
  const { recipe } = request;
  const run = { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
  if (recipe.kind === "frame") return { ...await renderFrame(recipe, local(inputs, recipe.inputId), output, run), durationSeconds: null, cover: null };
  if (recipe.kind === "people" || recipe.kind === "scene_cuts") {
    if (recipe.kind === "people") await detectPeople(recipe, local(inputs, recipe.inputId), output, request, run);
    else await detectScenes(recipe, local(inputs, recipe.inputId), output, request, run);
    return { width: null, height: null, durationSeconds: null, cover: null };
  }
  if (recipe.kind === "copy_carrier") await copyCarrier(recipe, local(inputs, recipe.inputId), output, { signal, limits }, run);
  else if (recipe.kind === "stitch") await ("clips" in recipe ? transitionStitch(recipe, inputs, directory, output, run) : stitch(recipe, inputs, directory, output, run));
  else if (recipe.kind === "model_composite") await compositeWindow(recipe, inputs, output, run);
  else if (recipe.kind === "transition_window") await renderTransitionWindow(recipe, inputs, directory, output, run);
  else await renderWindow(recipe, local(inputs, recipe.inputId), output, run);
  const metadata = await readVideoMetadata(output, request, recipe.kind);
  if (recipe.kind !== "stitch" || "clips" in recipe || recipe.target.alpha !== "packed") return { ...metadata, cover: null };
  const { rect, planeWidth } = placement(recipe.target);
  return { ...metadata, cover: null, packing: { packedWidth: recipe.target.width, packedHeight: recipe.target.height, colorRect: rect, alphaRect: { ...rect, x: rect.x + planeWidth } } };
}
