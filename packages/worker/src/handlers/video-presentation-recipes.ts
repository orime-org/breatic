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
  type VideoPresentationLedger, type VideoPresentationLedgerReceipt,
} from '@breatic/shared';
import { videoCarrierGeometry } from '@breatic/shared/mini-tools';

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
 * start to its last frame's end (a held last frame included), shown from the source time at its start, or from its first
 * frame when that comes later; its decode starts at the latest presented keyframe at or before that frame, or at the frame
 * itself when none is (§91 D3b-4). Each derived-empty frame is its own entry with the plan's fill.
 * @param ledger - The full ledger.
 * @param window - The window.
 * @returns The entries in presentation order.
 * @throws {RangeError} When the window lies outside the presented frames.
 */
export function windowEntries(ledger: VideoPresentationLedger, window: FrameWindow): MiniToolPlanEntry[] {
  const { plan } = ledger;
  const frames = presentedFrames(ledger);
  if (window.start < 0 || window.end > frames.length || window.end <= window.start) throw new RangeError('The window lies outside the presented frames');
  const scale = BigInt(plan.presentation.timescale);
  const base = q(plan.originMapping.timeBase);
  const spans = plan.videoSpans;
  /**
   * A display tick as time.
   * @param tick - The tick.
   * @returns The time.
   * @throws {never} Never.
   */
  const time = (tick: number): Q => [BigInt(tick), scale];
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
  /**
   * The source time a presentation time shows.
   * @param at - The presentation time.
   * @param span - Its edit, -1 without edits.
   * @returns The source time.
   * @throws {never} Never.
   */
  const sourceAt = (at: Q, span: number): Q => {
    if (span < 0) return plus(at, q(plan.originMapping.origin));
    const edit = spans![span]!;
    return plus(q(edit.sourceStart), times(minus(at, q(edit.presentationStart)), q(edit.rate)));
  };
  const keyframes = ledger.encoding.keyframeOrdinals;
  const entries: MiniToolPlanEntry[] = [];
  let open: { span: number; first: number; end: number } | null = null;
  /**
   * Close the open source span into an entry.
   * @throws {never} Never.
   */
  const close = (): void => {
    if (open === null) return;
    const first = frames[open.first]!;
    const firstSource = source(first.pts!);
    const displayStart = time(first.start);
    const shown = sourceAt(displayStart, open.span);
    let decode = firstSource;
    for (const ordinal of keyframes) {
      const pts = ordinal <= open.first ? frames[ordinal]!.pts : null;
      if (pts !== null && cmp(source(pts), firstSource) <= 0n && (decode === firstSource || cmp(source(pts), decode) > 0n)) decode = source(pts);
    }
    entries.push({ kind: 'source', decodeStart: exact(decode), clipStart: exact(cmp(shown, firstSource) > 0n ? shown : firstSource),
      displayStart: exact(displayStart), displayEnd: exact(time(open.end)), rate: open.span < 0 ? { numerator: '1', denominator: '1' } : exact(q(spans![open.span]!.rate)) });
    open = null;
  };
  for (let ordinal = window.start; ordinal < window.end; ordinal += 1) {
    const frame = frames[ordinal]!;
    if (frame.pts === null) {
      close();
      entries.push({ kind: 'empty', fill: plan.policy.emptyFill, window: { start: exact(time(frame.start)), end: exact(time(frame.end)) } });
      continue;
    }
    const span = spanAt(time(frame.start));
    if (open !== null && open.span === span) { open.end = frame.end; continue; }
    close();
    open = { span, first: ordinal, end: frame.end };
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

/**
 * The input id a stitch binds its chunk under: fixed per chunk index, so a rebuilt request is the same request.
 * @param chunk - The chunk index.
 * @returns A UUID distinct from the source input's.
 * @throws {never} Never.
 */
export function chunkInputId(chunk: number): string {
  return `00000000-0000-4000-8001-${String(chunk).padStart(12, '0')}`;
}
