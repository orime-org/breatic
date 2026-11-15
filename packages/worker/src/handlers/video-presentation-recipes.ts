// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The presentation recipes built from the full ledger (inner#1306 §91 D3b; frames-split design §7.17, the worker's recipe
 * construction being the one place that reads it, §5.3 model-input row, §5.4, §4.3): a window's presented frames become clip-span and derived-empty entries in
 * presentation time, the target comes from the plan and the frozen encode parameters, and a stitch carries each chunk's
 * plan duration and the whole interval's audio. The container never reads the ledger.
 */

import { getMiniToolsConfig } from '@breatic/core';
import {
  BodyTooLarge, EmptyBody, readVideoPresentationLedger, VideoSourceLedgerReadRefused, type MiniToolPlanAudio, type MiniToolPlanEntry, type MiniToolPlanExact, type MiniToolPlanInterval, type MiniToolPlanTarget,
  type MiniToolPlanDetectorProfile, type MiniToolPlanFrameCrop, type MiniToolPlanFrameTarget, type MiniToolPlanRecipe,
  type VideoPresentationLedger, type VideoPresentationLedgerReceipt,
} from '@breatic/shared';
import { conformedTime, presentationConform, videoCarrierGeometry } from '@breatic/shared/mini-tools';

/** An exact rational as numerator and positive denominator. */
type Q = [bigint, bigint];
/** One presented frame: its display ticks and its source pts ticks, null for a derived-empty frame. */
interface PresentedFrame { start: number; end: number; pts: bigint | null }
/** A frame window in presented ordinals. */
export interface FrameWindow { start: number; end: number }

/**
 * Parse an exact time.
 * @param value - The time.
 * @returns Its parts.
 * @throws {SyntaxError} When a part is not an integer.
 */
function q(value: MiniToolPlanExact): Q {
  return [BigInt(value.numerator), BigInt(value.denominator)];
}

/**
 * Write an exact time reduced, as the recipe schema requires.
 * @param value - The parts.
 * @returns The reduced time.
 * @throws {never} Never.
 */
function exact(value: Q): MiniToolPlanExact {
  const [numerator, denominator] = value;
  let [a, b] = [numerator < 0n ? -numerator : numerator, denominator];
  while (b !== 0n) [a, b] = [b, a % b];
  const divisor = a === 0n ? denominator : a;
  return { numerator: String(numerator / divisor), denominator: String(denominator / divisor) };
}

/**
 * Add two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The sum.
 * @throws {never} Never.
 */
function plus(left: Q, right: Q): Q {
  const [[a, b], [c, d]] = [left, right];
  return [a * d + c * b, b * d];
}

/**
 * Subtract two exact values.
 * @param left - The minuend.
 * @param right - The subtrahend.
 * @returns The difference.
 * @throws {never} Never.
 */
function minus(left: Q, right: Q): Q {
  const [[a, b], [c, d]] = [left, right];
  return [a * d - c * b, b * d];
}

/**
 * Multiply two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns The product.
 * @throws {never} Never.
 */
function times(left: Q, right: Q): Q {
  const [[a, b], [c, d]] = [left, right];
  return [a * c, b * d];
}

/**
 * Compare two exact values.
 * @param left - One.
 * @param right - The other.
 * @returns Negative, zero or positive as left is below, at or above right.
 * @throws {never} Never.
 */
function cmp(left: Q, right: Q): bigint {
  const [[a, b], [c, d]] = [left, right];
  return a * d - c * b;
}

/** A full ledger whose bytes or content fail its receipt or plan: a content mismatch, not a transport failure (§91 D3b-9). */
export class FullLedgerInvalid extends Error {
  /**
   * Build one.
   * @param cause - What refused it.
   */
  constructor(cause: unknown) {
    super('source_ledger_invalid', { cause });
    this.name = 'FullLedgerInvalid';
  }
}

// The read checks that refuse what arrived; `status` and every thrown transport error keep the normal retry.
const CONTENT_REFUSALS: ReadonlySet<string> = new Set(['content_type', 'size', 'digest', 'content']);

/**
 * Read a job's full ledger from the receipt of its own plan (§5.3 validatedFullLedger, §91 D3b-7): the caller passes the
 * receipt its plan names (the DO's candidate ledger, keyed by the plan's toolInputId, or the run's frozen receipt, bound to
 * its presentation ref by the plan service), and the shared read requires the bytes to match the receipt's sha256 and size
 * and the ledger to name the receipt's source, toolInputId and planSha256.
 * @param receipt - The plan's own ledger receipt.
 * @param deadlineAt - The job deadline.
 * @returns The full ledger.
 * @throws {FullLedgerInvalid} When what arrived fails the receipt.
 * @throws {Error} When the read fails in transport (reset, non-2xx before the body, deadline).
 */
export async function readJobLedger(receipt: VideoPresentationLedgerReceipt, deadlineAt: number): Promise<VideoPresentationLedger> {
  try {
    return await readVideoPresentationLedger(receipt, { maxBytes: getMiniToolsConfig().presentation.source_ledger.max_bytes }, { deadlineAt });
  } catch (error) {
    if (error instanceof BodyTooLarge || error instanceof EmptyBody || (error instanceof VideoSourceLedgerReadRefused && CONTENT_REFUSALS.has(error.reason))) throw new FullLedgerInvalid(error);
    throw error;
  }
}

/**
 * Every presented frame: display ticks from the presentation table, source ticks from the origin mapping.
 * @param ledger - The full ledger.
 * @returns The frames in presentation order.
 * @throws {never} The ledger schema keeps both in step.
 */
function presentedFrames(ledger: VideoPresentationLedger): PresentedFrame[] {
  const frames: PresentedFrame[] = [];
  for (const run of ledger.plan.presentation.runs) {
    for (let index = 0; index < run.count; index += 1) {
      const start = run.start + index * run.step;
      frames.push({ start, end: start + run.duration, pts: null });
    }
  }
  let at = 0;
  for (const entry of ledger.plan.originMapping.entries) {
    if (entry.kind === 'derived-empty') { at += 1; continue; }
    for (let index = 0; index < entry.count; index += 1) frames[at + index]!.pts = BigInt(entry.start) + BigInt(index) * BigInt(entry.step);
    at += entry.count;
  }
  return frames;
}

/**
 * A window's entries (§7.17, §91 D3-1): consecutive real frames of one edit form a source span from its first frame's
 * start to its last frame's end (a held last frame included), shown from its first frame's pts (or the edit start when the
 * edit cuts into that frame) plus its display offset at the span's rate; a derived-lead first frame is its own entry; its decode starts at the latest source keyframe whose pts is not after that frame, presented
 * or not, at the keyframe's dts less min(0, the first packet's dts) (§93 D6-1, §7.17 timeline row). Each derived-empty frame
 * is its own entry with the plan's fill. With `from`, the first entry starts at that presentation time inside the first
 * frame instead (a chunk on an output frame grid starts at its first slot's time, §7.17 transition output profile row).
 * Entries for an output frame grid (`grid`) of a table whose clock rounded a constant rate's frame times (§7.17 rounding
 * clock row) put every frame from the second on at its exact grid point, and each source span carries that grid in source
 * time for the container to snap the stored frame times to.
 * @param ledger - The full ledger.
 * @param window - The window.
 * @param from - A presentation time in the window's first frame to start from; that frame's start when absent.
 * @param grid - Whether the entries are placed on an output frame grid.
 * @returns The entries in presentation order.
 * @throws {RangeError} When the window lies outside the presented frames or `from` outside its first frame.
 */
export function windowEntries(ledger: VideoPresentationLedger, window: FrameWindow, from?: MiniToolPlanExact, grid = false): MiniToolPlanEntry[] {
  return placedEntries(ledger, window, from === undefined ? undefined : q(from), grid).map(({ entry }) => entry);
}

/**
 * A window's entries, each with the presentation ordinal of its first frame.
 * @param ledger - The full ledger.
 * @param window - The window.
 * @param from - A presentation time in the window's first frame to start from; that frame's start when absent.
 * @param grid - Whether the entries are placed on an output frame grid.
 * @returns The entries in presentation order with their first ordinals.
 * @throws {RangeError} When the window lies outside the presented frames, `from` outside its first frame, or no source keyframe precedes a span.
 */
function placedEntries(ledger: VideoPresentationLedger, window: FrameWindow, from: Q | undefined, grid: boolean): { entry: MiniToolPlanEntry; ordinal: number }[] {
  const { plan } = ledger;
  const frames = presentedFrames(ledger);
  if (window.start < 0 || window.end > frames.length || window.end <= window.start) throw new RangeError('The window lies outside the presented frames');
  const scale = BigInt(plan.presentation.timescale);
  const conform = grid ? presentationConform(plan.presentation) : null;
  /**
   * A display tick as time.
   * @param tick - The tick.
   * @returns The time.
   * @throws {never} Never.
   */
  const time = (tick: number): Q => [BigInt(tick), scale];
  /**
   * Where a frame starts: its stored start, or on a conform grid its grid point (the first frame keeps the presentation start).
   * @param ordinal - The frame.
   * @returns The time.
   * @throws {never} Never.
   */
  const startOf = (ordinal: number): Q => (conform === null || ordinal === 0 ? time(frames[ordinal]!.start) : conformedTime(conform, time(frames[ordinal]!.start)));
  /**
   * Where a frame ends: its stored end, or on a conform grid where the next frame starts (the last frame keeps its end).
   * @param ordinal - The frame.
   * @returns The time.
   * @throws {never} Never.
   */
  const endOf = (ordinal: number): Q => (conform === null || ordinal + 1 === frames.length ? time(frames[ordinal]!.end) : startOf(ordinal + 1));
  if (from !== undefined && (cmp(from, startOf(window.start)) < 0n || cmp(from, endOf(window.start)) >= 0n)) {
    throw new RangeError('The start lies outside the window\'s first frame');
  }
  const base = q(plan.originMapping.timeBase);
  const spans = plan.videoSpans;
  /**
   * A source pts as time.
   * @param pts - Source ticks.
   * @returns The time.
   * @throws {never} Never.
   */
  const source = (pts: bigint): Q => [pts * base[0], base[1]];
  /**
   * The edit that presents a time, or -1 without edits.
   * @param at - A presentation time.
   * @returns The span index.
   * @throws {never} Never.
   */
  const spanAt = (at: Q): number => spans === null ? -1 : spans.findIndex((span) => {
    const [rateNumerator, rateDenominator] = q(span.rate);
    const end = plus(q(span.presentationStart), times(minus(q(span.sourceEnd), q(span.sourceStart)), [rateDenominator, rateNumerator]));
    return cmp(at, q(span.presentationStart)) >= 0n && cmp(at, end) < 0n;
  });
  const keyframes = ledger.encoding.sourceKeyframes.map(({ pts, dts }) => ({ pts: q(pts), dts: q(dts) }));
  const firstDts = q(ledger.encoding.firstPacketDts);
  const shift: Q = cmp(firstDts, [0n, 1n]) < 0n ? minus([0n, 1n], firstDts) : [0n, 1n];
  // A derived-lead first frame shows its one source frame from the lead start (§7.17 timeline row), longer than that frame
  // lasts: it is its own entry from its own pts at rate 1/n, n the lead over the frame's own source length, so the trim ends
  // within that frame and the clock gains no factor beyond the source tick.
  const leadOrdinal = plan.originMapping.firstSource.lead === null ? -1 : frames.findIndex((frame) => frame.pts !== null);
  let leadRate: Q = [1n, 1n];
  if (leadOrdinal >= 0) {
    const lead = frames[leadOrdinal]!;
    const last = frames.findLastIndex((frame) => frame.pts !== null) === leadOrdinal;
    const supportStart = q(plan.originMapping.firstSource.supportStart);
    const span = spanAt(supportStart);
    // The frame shows itself from its support start to its end, or to the support end when it is also the last frame.
    const shown = minus(last ? q(plan.originMapping.lastSource.supportEnd) : time(lead.end), supportStart);
    const length = times(shown, span < 0 ? [1n, 1n] : q(spans![span]!.rate));
    const [display, own] = [BigInt(lead.end - lead.start) * length[1], scale * length[0]];
    if (own > 0n) leadRate = [1n, (display + own - 1n) / own];
  }
  const entries: { entry: MiniToolPlanEntry; ordinal: number }[] = [];
  let open: { span: number; first: number; last: number } | null = null;
  /**
   * Close the open source span into an entry.
   * @throws {never} Never.
   */
  const close = (): void => {
    if (open === null) return;
    const first = frames[open.first]!;
    const firstSource = source(first.pts!);
    const displayStart = open.first === window.start && from !== undefined ? from : startOf(open.first);
    let keyframe: { pts: Q; dts: Q } | undefined;
    for (const candidate of keyframes) {
      if (cmp(candidate.pts, firstSource) <= 0n && (keyframe === undefined || cmp(candidate.pts, keyframe.pts) > 0n)) keyframe = candidate;
    }
    if (keyframe === undefined) throw new RangeError('No source keyframe precedes the span');
    const decode = plus(keyframe.dts, shift);
    const lead = open.first === leadOrdinal;
    const edit = open.span < 0 ? null : spans![open.span]!;
    const rate: Q = lead ? leadRate : edit === null ? [1n, 1n] : q(edit.rate);
    // The span's first frame shows its source from its pts, or from the edit start when the edit cuts into it, advancing at the
    // span's rate from the frame's display start; the held lead frame always shows from its pts.
    const from0 = edit !== null && cmp(q(edit.sourceStart), firstSource) > 0 ? q(edit.sourceStart) : firstSource;
    /**
     * A presentation time in the span's source time: the frame's stored start is its source start, advancing at the rate.
     * @param at - The presentation time.
     * @returns The source time.
     * @throws {never} Never.
     */
    const sourceOf = (at: Q): Q => plus(from0, times(minus(at, time(first.start)), rate));
    const clipStart = lead ? firstSource : sourceOf(displayStart);
    // The conform grid in the span's source time, which the container snaps the stored frame times to; a held lead frame is one
    // frame shown from its pts.
    const snap = conform === null || lead ? {} : { conform: { origin: exact(sourceOf(q(conform.origin))), period: exact(times(q(conform.period), rate)) } };
    entries.push({ ordinal: open.first, entry: { kind: 'source', decodeStart: exact(decode), clipStart: exact(clipStart),
      displayStart: exact(displayStart), displayEnd: exact(endOf(open.last)), rate: exact(rate), ...snap } });
    open = null;
  };
  for (let ordinal = window.start; ordinal < window.end; ordinal += 1) {
    const frame = frames[ordinal]!;
    if (frame.pts === null) {
      close();
      const start = ordinal === window.start && from !== undefined ? from : startOf(ordinal);
      entries.push({ ordinal, entry: { kind: 'empty', fill: plan.policy.emptyFill, window: { start: exact(start), end: exact(endOf(ordinal)) } } });
      continue;
    }
    const span = spanAt(time(frame.start));
    if (open !== null && open.span === span && open.first !== leadOrdinal) { open.last = ordinal; continue; }
    close();
    open = { span, first: ordinal, last: ordinal };
  }
  close();
  return entries;
}

/**
 * A window's presentation interval.
 * @param ledger - The full ledger.
 * @param window - The window.
 * @returns From its first frame's start to its last frame's end.
 * @throws {RangeError} When the window lies outside the presented frames.
 */
export function windowInterval(ledger: VideoPresentationLedger, window: FrameWindow): MiniToolPlanInterval {
  const frames = presentedFrames(ledger);
  const [first, last] = [frames[window.start], frames[window.end - 1]];
  if (first === undefined || last === undefined || window.end <= window.start) throw new RangeError('The window lies outside the presented frames');
  const scale = BigInt(ledger.plan.presentation.timescale);
  return { start: exact([BigInt(first.start), scale]), end: exact([BigInt(last.end), scale]) };
}

/**
 * A window's plan duration, which places its chunk in a stitch (§5.4).
 * @param ledger - The full ledger.
 * @param window - The window.
 * @returns The duration.
 * @throws {RangeError} When the window lies outside the presented frames.
 */
export function windowDuration(ledger: VideoPresentationLedger, window: FrameWindow): MiniToolPlanExact {
  const { start, end } = windowInterval(ledger, window);
  return exact(minus(q(end), q(start)));
}

/**
 * The audio of a presentation interval (§91 D3b-11): the plan's origin and audio spans, by which the container places the
 * samples. The plan does not record whether the source has audio, so the container adds it only when there is some (D3b-2).
 * @param ledger - The full ledger.
 * @param interval - The presentation interval; the whole display when absent.
 * @returns The recipe's audio.
 * @throws {never} Never.
 */
export function audioOf(ledger: VideoPresentationLedger, interval?: MiniToolPlanInterval): MiniToolPlanAudio {
  const { start, end } = interval ?? { start: { numerator: '0', denominator: '1' }, end: ledger.plan.display.duration };
  return { start, end, origin: ledger.plan.originMapping.origin, spans: ledger.plan.audioSpans };
}

/**
 * The display carrier's target (§91 D-2, §8.2, §4.3): the capped, even geometry, the plan's matrix and conversion, and the
 * encode parameters frozen at admission. A plan sets `emptyFill: 'transparent'` exactly when the probe confirmed alpha
 * (`presentation-run.ts` policy, inside planSha256), so that source is packed: two even planes side by side (§91 D3b-6).
 * @param ledger - The full ledger.
 * @param carrier - The frozen carrier parameters.
 * @param carrier.crf - The crf.
 * @param carrier.preset - The preset.
 * @param carrier.maxShortSide - The short-side cap.
 * @returns The target.
 * @throws {RangeError} When the display or cap is not a positive integer.
 */
export function carrierTarget(ledger: VideoPresentationLedger, carrier: { crf: number; preset: MiniToolPlanTarget['preset']; maxShortSide: number }): MiniToolPlanTarget {
  const { plan } = ledger;
  const geometry = videoCarrierGeometry(plan.display, carrier.maxShortSide);
  const packed = plan.policy.emptyFill === 'transparent';
  return { width: packed ? geometry.width * 2 : geometry.width, height: geometry.height, displayRect: geometry.displayRect, colorMatrix: plan.colorMatrix,
    toneMap: plan.output.toneMap, alpha: packed ? 'packed' : 'none', crf: carrier.crf, preset: carrier.preset };
}

/**
 * A model input's target (§5.3 model-input row, §91 D3-4, D3b-5): the display geometry with odd sides padded to even and
 * the picture rectangle kept, no carrier cap, opaque, with the plan's matrix and conversion and the frozen encode parameters.
 * @param ledger - The full ledger.
 * @param encode - The encode parameters frozen at admission.
 * @param encode.crf - The crf.
 * @param encode.preset - The preset.
 * @returns The target.
 * @throws {RangeError} When the display is not a positive integer size.
 */
export function modelInputTarget(ledger: VideoPresentationLedger, encode: { crf: number; preset: MiniToolPlanTarget['preset'] }): MiniToolPlanTarget {
  const { plan } = ledger;
  const geometry = videoCarrierGeometry(plan.display, Number.MAX_SAFE_INTEGER);
  return { ...geometry, colorMatrix: plan.colorMatrix, toneMap: plan.output.toneMap, alpha: 'none', crf: encode.crf, preset: encode.preset };
}

/** The input id every recipe binds the registered source under. */
export const SOURCE_INPUT_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The input id a stitch binds its chunk under: fixed per chunk index, so a rebuilt request is the same request.
 * @param chunk - The chunk index.
 * @returns A UUID distinct from the source input's.
 * @throws {never} Never.
 */
export function chunkInputId(chunk: number): string {
  return `00000000-0000-4000-8001-${String(chunk).padStart(12, '0')}`;
}

/** A tool PNG's target (§91 D4-3, §7.17 frame row). */
type FrameTarget = MiniToolPlanFrameTarget;
/** A split output's target (§91 D4-4, §4.3 odd-size row): opaque H.264 MP4 at even sides, transparent VP9 WebM at the display size. */
export type SegmentTarget = MiniToolPlanTarget & { format: 'mp4-h264' | 'webm-vp9' };
/** A presentation-coordinate frame selection, as the execution and analysis record it (§91 D4-10). */
export interface FrameSelection { frameIndex: number; pts: number }
/** A frame recipe on a full-ledger entry. */
export type FrameRecipe = Extract<MiniToolPlanRecipe, { kind: 'frame'; entry: MiniToolPlanEntry }>;
/** The job-level recipes a split segment becomes. */
export type SegmentRecipe = Extract<MiniToolPlanRecipe, { kind: 'segment' | 'chunk_encode' | 'stitch' }>;

/**
 * The plan's PNG target (§7.17 frame row, §4.3): the upright display geometry, its matrix and tone mapping, the plan's PNG
 * depth, and alpha kept for a transparent source (the plan's fill is `transparent` exactly when the probe confirmed alpha).
 * @param ledger - The full ledger.
 * @returns The target.
 * @throws {never} Never.
 */
function frameTarget(ledger: VideoPresentationLedger): FrameTarget {
  const { plan } = ledger;
  return { width: plan.display.width, height: plan.display.height, colorMatrix: plan.colorMatrix, toneMap: plan.output.toneMap,
    pngBitDepth: plan.output.framePngBitDepth, alpha: plan.policy.emptyFill === 'transparent' ? 'straight' : 'none' };
}

/**
 * The one entry presenting a selected frame; the selection must name the frame by its ordinal and its own display time.
 * @param ledger - The full ledger.
 * @param selection - The selected frame.
 * @returns Its entry.
 * @throws {RangeError} When the ordinal is outside the frames or the pts is not that frame's.
 */
function frameEntry(ledger: VideoPresentationLedger, selection: FrameSelection): MiniToolPlanEntry {
  const frame = presentedFrames(ledger)[selection.frameIndex];
  if (!Number.isSafeInteger(selection.frameIndex) || frame === undefined || frame.start / ledger.plan.presentation.timescale !== selection.pts) {
    throw new RangeError('The selection is not a presented frame');
  }
  return windowEntries(ledger, { start: selection.frameIndex, end: selection.frameIndex + 1 })[0]!;
}

/**
 * The frame recipe of a selected presented frame (§91 D4-3): its entry and the plan's PNG target.
 * @param ledger - The full ledger.
 * @param selection - The selected frame.
 * @param inputId - The source input.
 * @returns The recipe.
 * @throws {RangeError} When the selection is not a presented frame.
 */
export function frameRecipeOf(ledger: VideoPresentationLedger, selection: FrameSelection, inputId: string): FrameRecipe {
  return { kind: 'frame', inputId, entry: frameEntry(ledger, selection), target: frameTarget(ledger) };
}

/**
 * A people candidate's crop: the anchor's frame recipe cropped in its display geometry.
 * @param ledger - The full ledger.
 * @param anchor - The analysis anchor.
 * @param inputId - The source input.
 * @param crop - The candidate's display crop.
 * @returns The recipe.
 * @throws {RangeError} When the anchor is not a presented frame.
 */
export function candidateCropRecipeOf(ledger: VideoPresentationLedger, anchor: FrameSelection, inputId: string, crop: MiniToolPlanFrameCrop): FrameRecipe {
  return { ...frameRecipeOf(ledger, anchor, inputId), crop };
}

/**
 * The people detection recipe (§91 D4-5): the anchor's entry (a derived-empty anchor is composed) and the upright target.
 * @param ledger - The full ledger.
 * @param anchor - The analysis anchor.
 * @param inputId - The source input.
 * @param profile - The detector profile.
 * @returns The recipe.
 * @throws {RangeError} When the anchor is not a presented frame.
 */
export function peopleRecipeOf(ledger: VideoPresentationLedger, anchor: FrameSelection, inputId: string, profile: MiniToolPlanDetectorProfile):
  Extract<MiniToolPlanRecipe, { kind: 'people'; entry: MiniToolPlanEntry }> {
  return { kind: 'people', inputId, entry: frameEntry(ledger, anchor), target: frameTarget(ledger), profile };
}

/**
 * The presented frames a time range in seconds covers; both ends must fall on frame boundaries.
 * @param ledger - The full ledger.
 * @param range - The range.
 * @param range.start - Its start.
 * @param range.end - Its end.
 * @returns The frame window.
 * @throws {RangeError} When an end is not a frame boundary or the range is empty.
 */
export function rangeWindow(ledger: VideoPresentationLedger, range: { start: number; end: number }): FrameWindow {
  const frames = presentedFrames(ledger);
  const scale = ledger.plan.presentation.timescale;
  const start = frames.findIndex((frame) => frame.start / scale === range.start);
  const last = frames.findIndex((frame) => frame.end / scale === range.end);
  if (start < 0 || last < start) throw new RangeError('The range does not fall on frame boundaries');
  return { start, end: last + 1 };
}

/**
 * A split output's target (§91 D4-4, §4.3 odd-size row): opaque sources are H.264 MP4 with odd sides rounded down to even
 * (a 1-pixel side to 2), transparent ones VP9 WebM with alpha at the display size; the frozen crf and preset.
 * @param ledger - The full ledger.
 * @param carrier - The frozen encode parameters.
 * @param carrier.crf - The crf.
 * @param carrier.preset - The preset.
 * @returns The target.
 * @throws {never} Never.
 */
export function segmentTarget(ledger: VideoPresentationLedger, carrier: { crf: number; preset: MiniToolPlanTarget['preset'] }): SegmentTarget {
  const { plan } = ledger;
  const transparent = plan.policy.emptyFill === 'transparent';
  /**
   * An opaque side rounded down to even, at least 2.
   * @param side - The display side.
   * @returns The output side.
   * @throws {never} Never.
   */
  const even = (side: number): number => (transparent ? side : Math.max(2, side - (side % 2)));
  return { width: even(plan.display.width), height: even(plan.display.height), displayRect: null, colorMatrix: plan.colorMatrix, toneMap: plan.output.toneMap,
    alpha: transparent ? 'straight' : 'none', crf: carrier.crf, preset: carrier.preset, format: transparent ? 'webm-vp9' : 'mp4-h264' };
}

/**
 * A split segment's job recipes (§91 D4-4, §5.4): one segment over its window, or, when the shared planner gave several
 * windows, one chunk_encode per window and a stitch over them with each chunk's plan duration and the range's audio.
 * @param ledger - The full ledger.
 * @param selection - The execution's range in presentation seconds.
 * @param selection.range - The range.
 * @param selection.range.start - Its start in seconds.
 * @param selection.range.end - Its end in seconds.
 * @param inputId - The source input.
 * @param carrier - The frozen encode parameters.
 * @param carrier.crf - The crf.
 * @param carrier.preset - The preset.
 * @param windows - The chunk windows the shared planner gave for the range.
 * @returns The recipes.
 * @throws {RangeError} When the range is not on frame boundaries or the windows do not tile its frames.
 */
export function segmentRecipesOf(ledger: VideoPresentationLedger, selection: { range: { start: number; end: number } }, inputId: string,
  carrier: { crf: number; preset: MiniToolPlanTarget['preset'] }, windows: readonly FrameWindow[]): SegmentRecipe[] {
  const range = rangeWindow(ledger, selection.range);
  if (windows.length === 0 || windows[0]!.start !== range.start || windows.at(-1)!.end !== range.end ||
    windows.some((window, at) => window.end <= window.start || (at > 0 && windows[at - 1]!.end !== window.start))) throw new RangeError('The windows do not tile the range');
  const target = segmentTarget(ledger, carrier);
  const timescale = ledger.plan.presentation.timescale;
  const audio = audioOf(ledger, windowInterval(ledger, range));
  if (windows.length === 1) return [{ kind: 'segment', inputId, window: { ...range }, timescale, entries: windowEntries(ledger, range), target, audio }];
  return [
    ...windows.map((window): SegmentRecipe => ({ kind: 'chunk_encode', inputId, window: { start: window.start, end: window.end }, timescale, entries: windowEntries(ledger, window), target })),
    { kind: 'stitch', inputId, chunks: windows.map((window, chunk) => ({ inputId: chunkInputId(chunk), duration: windowDuration(ledger, window) })), audio, target },
  ];
}

/**
 * The scene-cut recipe (§91 D4-5): the scanned range's entries, each with the presentation ordinal of its first frame, so
 * cuts come back as presentation ordinals; no inspect step.
 * @param ledger - The full ledger.
 * @param range - The scanned range in presentation seconds.
 * @param range.start - Its start.
 * @param range.end - Its end.
 * @param inputId - The source input.
 * @param profile - The detector profile.
 * @returns The recipe.
 * @throws {RangeError} When the range is not on frame boundaries.
 */
export function sceneCutsRecipeOf(ledger: VideoPresentationLedger, range: { start: number; end: number }, inputId: string, profile: MiniToolPlanDetectorProfile):
  Extract<MiniToolPlanRecipe, { kind: 'scene_cuts'; entries: unknown }> {
  const { plan } = ledger;
  const window = rangeWindow(ledger, range);
  return { kind: 'scene_cuts', inputId, window, timescale: plan.presentation.timescale, profile,
    entries: placedEntries(ledger, window, undefined, false).map(({ entry, ordinal }) => ({ ...entry, ordinalOffset: ordinal })),
    target: { width: plan.display.width, height: plan.display.height, colorMatrix: plan.colorMatrix, toneMap: plan.output.toneMap } };
}

/**
 * Scene cuts reported as presentation ordinals, checked against the scanned window and given their display times from the
 * table (§91 D4-5: the compact check is in the worker's result assembly).
 * @param ledger - The full ledger.
 * @param window - The scanned window.
 * @param cuts - The reported cut ordinals.
 * @returns Each cut's ordinal and display time.
 * @throws {RangeError} When a cut lies outside the window.
 */
export function sceneCutsResultOf(ledger: VideoPresentationLedger, window: FrameWindow, cuts: readonly number[]): FrameSelection[] {
  const frames = presentedFrames(ledger);
  const scale = ledger.plan.presentation.timescale;
  return cuts.map((ordinal) => {
    if (!Number.isSafeInteger(ordinal) || ordinal < window.start || ordinal >= window.end || frames[ordinal] === undefined) throw new RangeError('A scene cut lies outside its window');
    return { frameIndex: ordinal, pts: frames[ordinal].start / scale };
  });
}
