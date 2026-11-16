// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { ExactPresentationTime, PhysicalVideoFrame, OwnedVideoPresentation } from "@shared/upload/video-source-ledger-types.js";
export type { ExactPresentationTime, PhysicalVideoFrame, OwnedEditInterval, OwnedPresentationOccurrence, OwnedVideoPresentation } from "@shared/upload/video-source-ledger-types.js";

import type { IsoBmffEdit } from "@ingest/container/iso-bmff-metadata.js";

/** A complete source ledger and its explicitly supplied edit schedule. */
export interface EditListPresentationInput {
  movieTimescale: string;
  mediaTimescale: string;
  sourceTimeBase: ExactPresentationTime;
  edits: IsoBmffEdit[];
  frames: PhysicalVideoFrame[];
}
/**
 * Materialize a reduced exact time using the existing presentation arithmetic.
 * @param numerator - Signed original integer time.
 * @param denominator - Caller-validated positive clock divisor.
 * @returns The owned decimal-string fraction.
 * @throws {never} Callers supply a positive denominator.
 */
export function exactPresentationTime(numerator: bigint, denominator: bigint): ExactPresentationTime {
  return exact(rational(numerator, denominator));
}

/**
 * Project complete positive-rate edits onto physical frames, including clipped overlap at an edit start and end.
 * An edit [T, T+d) at rate r presents source [m, m + d·r); source time p shows at T + (p − m)/r.
 * @param input - Integer source facts and a complete explicitly supplied edit schedule.
 * @param maxOccurrences - Frozen maximum expansion, independent from raw-frame count.
 * @returns Exact movie intervals and stable occurrence-to-raw identities.
 * @throws {Error} When clocks, edits, ledger or resource ceilings cannot form this exact plan.
 */
export function planEditListPresentation(input: EditListPresentationInput, maxOccurrences: number): OwnedVideoPresentation {
  if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences <= 0) throw presentationError("invalid_limits", "Occurrence ceiling must be a positive safe integer");
  const movieScale = positiveClock(input.movieTimescale);
  const mediaScale = positiveClock(input.mediaTimescale);
  const sourceNumerator = positiveClock(input.sourceTimeBase.numerator);
  const sourceDenominator = positiveClock(input.sourceTimeBase.denominator);
  const physical = physicalTimes(input.frames, sourceNumerator, sourceDenominator);
  const result: OwnedVideoPresentation = { edits: [], frames: [] };
  let movieStart = rational(0n, 1n);
  for (const [editOccurrence, edit] of input.edits.entries()) {
    const rateFixed = integer(edit.mediaRateFixed16_16, "unsupported_rate");
    if (rateFixed <= 0n) throw presentationError("unsupported_rate", "Edit rates must be positive");
    const rate = rational(rateFixed, 65536n);
    const durationTicks = integer(edit.segmentDurationMovieTicks, "invalid_edit");
    const mediaTicks = integer(edit.mediaTimeTrackTicks, "invalid_edit");
    if (durationTicks < 0n || mediaTicks < -1n) throw presentationError("invalid_edit", "Invalid edit duration or media time");
    const duration = rational(durationTicks, movieScale);
    const movieEnd = add(movieStart, duration);
    const empty = mediaTicks === -1n;
    result.edits.push({ editOccurrence, empty, start: exact(movieStart), end: exact(movieEnd) });
    if (!empty && durationTicks > 0n) {
      const mediaStart = rational(mediaTicks, mediaScale);
      const mediaEnd = add(mediaStart, multiply(duration, rate));
      const editStart = movieStart;
      /**
       * Movie time of a source time inside this edit.
       * @param source - Source time within the edit.
       * @returns Its movie time.
       * @throws {never} Never.
       */
      const toMovie = (source: Rational): Rational => add(editStart, divide(subtract(source, mediaStart), rate));
      let index = firstAtOrAfter(physical, mediaStart);
      if (index > 0) index -= 1;
      for (; index < physical.length; index += 1) {
        const pts = physical[index]!;
        if (compare(pts, mediaEnd) >= 0) break;
        const next = physical[index + 1] ?? mediaEnd;
        const start = compare(pts, mediaStart) < 0 ? mediaStart : pts;
        const end = compare(next, mediaEnd) > 0 ? mediaEnd : next;
        if (compare(start, end) >= 0) continue;
        if (result.frames.length >= maxOccurrences) throw presentationError("resource_limit", "Presentation occurrence ceiling exceeded");
        const frame = input.frames[index]!;
        result.frames.push({
          presentationOrdinal: result.frames.length, editOccurrence, rawDecodeOrdinal: frame.rawDecodeOrdinal,
          sourcePtsTicks: frame.ptsTicks, mappedPts: exact(toMovie(pts)),
          displayStart: exact(toMovie(start)), displayEnd: exact(toMovie(end)),
        });
      }
    }
    movieStart = movieEnd;
  }
  return result;
}


interface Rational { n: bigint; d: bigint }

/** Classify an exact-planning failure for callers without leaking a third-party shape.
 * @throws {never} Never.
 */
function presentationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Decode a decimal integer without permitting alternate radices or Number rounding.
 * @throws {Error} When the supplied fact is not a decimal integer.
 */
function integer(value: string, code: string): bigint {
  if (!/^-?\d+$/u.test(value)) throw presentationError(code, "Expected an exact decimal integer fact");
  return BigInt(value);
}

/** Decode a strictly positive clock component.
 * @throws {Error} When a clock component is unknown, malformed or nonpositive.
 */
function positiveClock(value: string): bigint {
  const parsed = integer(value, "invalid_clock");
  if (parsed <= 0n) throw presentationError("invalid_clock", "Clock divisors and time-base numerators must be positive");
  return parsed;
}

/** Reduce a fraction to its canonical positive-denominator exact form.
 * @throws {never} Never; callers provide positive denominators.
 */
function rational(n: bigint, d: bigint): Rational {
  let a = n < 0n ? -n : n;
  let b = d;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return { n: n / a, d: d / a };
}

/** Add exact times without converting either operand to floating point.
 * @throws {never} Never.
 */
function add(left: Rational, right: Rational): Rational { return rational(left.n * right.d + right.n * left.d, left.d * right.d); }

/** Subtract exact times without shifting their source origin.
 * @throws {never} Never.
 */
function subtract(left: Rational, right: Rational): Rational { return rational(left.n * right.d - right.n * left.d, left.d * right.d); }

/** Scale an exact time by an exact factor.
 * @throws {never} Never.
 */
function multiply(left: Rational, right: Rational): Rational { return rational(left.n * right.n, left.d * right.d); }

/** Divide an exact time by a positive exact factor.
 * @throws {never} Never; callers pass a positive divisor.
 */
function divide(left: Rational, right: Rational): Rational { return rational(left.n * right.d, left.d * right.n); }

/** Order exact rational times using their full integer products.
 * @throws {never} Never.
 */
function compare(left: Rational, right: Rational): number {
  const difference = left.n * right.d - right.n * left.d;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** Materialize an owned decimal-string time, without sharing mutable internal state.
 * @throws {never} Never.
 */
function exact(value: Rational): ExactPresentationTime { return { numerator: value.n.toString(), denominator: value.d.toString() }; }

/** Validate the complete identity order before planning repeated or backward edits.
 * @throws {Error} When ordinals are incomplete or physical presentation ticks are ambiguous.
 */
function physicalTimes(frames: PhysicalVideoFrame[], numerator: bigint, denominator: bigint): Rational[] {
  const times: Rational[] = [];
  let previous: bigint | undefined;
  for (const [index, frame] of frames.entries()) {
    if (frame.rawDecodeOrdinal !== index) throw presentationError("invalid_ledger", "Raw frame ordinals must be complete, dense and ordered");
    const ticks = integer(frame.ptsTicks, "invalid_ledger");
    if (previous !== undefined && ticks <= previous) throw presentationError("invalid_ledger", "Physical presentation ticks must strictly increase");
    times.push(rational(ticks * numerator, denominator));
    previous = ticks;
  }
  return times;
}

/** Find the first source picture at or after an edit, retaining its overlapping predecessor.
 * @throws {never} Never.
 */
function firstAtOrAfter(times: Rational[], start: Rational): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compare(times[middle]!, start) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}
