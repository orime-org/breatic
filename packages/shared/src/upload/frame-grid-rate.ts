// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The frame-grid rate rule and the probe facts read beside it (inner#1306 frames-split design §4.1 frame rate row, §4.2,
 * §5.4 estimate row, §3.2 item 7). Pure functions over ffprobe output, written from the behaviour the design describes.
 */

/** A frame rate (or any positive rational, such as ticks per second) in lowest terms. */
export interface FrameRate {
  numerator: number;
  denominator: number;
}

/** What the probe read for the rate rule. */
export interface FrameGridRateInput {
  /** `r_frame_rate`, null when ffprobe reports 0/0. */
  rFrameRate: FrameRate | null;
  /** `avg_frame_rate`, null when ffprobe reports 0/0. */
  avgFrameRate: FrameRate | null;
  /** Ticks per second: 1 / the stream time base. */
  ticksPerSecond: FrameRate;
  /** Every video packet time in ticks, in packet order (pts, or dts for a packet without pts). */
  ticks: number[];
  /** `presentation.max_fps`. */
  maxFps: number;
}

/** Which step of the rule decided the rate. */
export type FrameGridRateStep =
  | "nominal" | "singleFrame" | "lattice" | "rFrameRate" | "medianSnapped" | "trimmedMean" | "rounded" | "outOfRange";

/** Which scan condition sent the file to the packet scan. */
export type FrameGridScanReason = "avgInvalid" | "rOverMax" | "guessAvg" | "rUnnamed";

/** The rule's result. */
export interface FrameGridRate {
  fps: FrameRate;
  step: FrameGridRateStep;
  scanReason: FrameGridScanReason | null;
}

/** The closed source decode-rate keys (§5.4 estimate row). */
export const SOURCE_DECODE_KEYS = [
  "sdr_8bit", "sdr_10bit", "sdr_12bit", "sdr_alpha_layer", "sdr_prores", "sdr_dnx", "sdr_av1_8bit", "sdr_av1_10bit",
  "sdr_av1_12bit", "sdr_jpeg2000", "sdr_ffv1", "sdr_png", "sdr_other",
] as const;

/** One source decode-rate key. */
export type SourceDecodeKey = (typeof SOURCE_DECODE_KEYS)[number];

/** The probe facts `sourceDecodeKey` reads. */
export interface DecodeKeySource {
  /** ffprobe `codec_name`. */
  codec: string;
  /** Bit depth of the pixel format. */
  bitDepth: number;
  /** The probe's transparency classification. */
  alpha: "confirmed_alpha" | "confirmed_opaque";
}

/**
 * Builds a rational in lowest terms with a positive denominator.
 * @param numerator - The numerator.
 * @param denominator - The denominator, not zero.
 * @returns The reduced rational.
 * @throws {never} Pure arithmetic.
 */
function rational(numerator: number, denominator: number): FrameRate {
  /**
   * Greatest common divisor.
   * @param a - First value.
   * @param b - Second value.
   * @returns Their gcd.
   * @throws {never} Pure arithmetic.
   */
  const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
  const g = gcd(numerator, denominator) * Math.sign(denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

/**
 * A rational's value.
 * @param rate - The rational.
 * @returns Its floating-point value.
 * @throws {never} Pure arithmetic.
 */
function valueOf(rate: FrameRate): number {
  return rate.numerator / rate.denominator;
}

/**
 * Whether two rationals in lowest terms are equal.
 * @param a - First.
 * @param b - Second.
 * @returns True when equal.
 * @throws {never} Pure comparison.
 */
function sameRate(a: FrameRate, b: FrameRate): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}

/**
 * Compares a rational against a number exactly.
 * @param rate - The rational, positive denominator.
 * @param value - An integer.
 * @returns Negative, zero or positive as `rate` is below, at or above `value`.
 * @throws {never} Pure comparison.
 */
function compareTo(rate: FrameRate, value: number): number {
  return rate.numerator - value * rate.denominator;
}

/**
 * Rounds half to even, so a multiple exactly between two lattice points goes to the even one.
 * @param x - The value.
 * @returns The nearest integer, ties to even.
 * @throws {never} Pure arithmetic.
 */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const rest = x - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const NTSC_RATES: readonly FrameRate[] = [24000, 30000, 48000, 60000, 120000].map((n) => rational(n, 1001));

/** Rates the integer-multiple fit prefers inside its error range. */
const KNOWN_RATES: ReadonlyArray<readonly [number, FrameRate]> = [
  [12, rational(12, 1)], [15, rational(15, 1)], [20, rational(20, 1)], [24000 / 1001, rational(24000, 1001)],
  [24, rational(24, 1)], [25, rational(25, 1)], [30000 / 1001, rational(30000, 1001)], [30, rational(30, 1)],
  [48, rational(48, 1)], [50, rational(50, 1)], [60000 / 1001, rational(60000, 1001)], [60, rational(60, 1)],
  [100, rational(100, 1)], [120000 / 1001, rational(120000, 1001)], [120, rational(120, 1)], [144, rational(144, 1)],
  [240, rational(240, 1)],
];

/** N/1001 rates a median snaps to within 0.05%. */
const SPECIAL_RATES: ReadonlyArray<readonly [number, FrameRate]> = [24, 30, 60, 120].map(
  (n) => [n / 1.001, rational(n * 1000, 1001)] as const,
);

/** Common integer rates a median or trimmed mean snaps to within 2.5%. */
const COMMON_RATES: ReadonlyArray<readonly [number, FrameRate]> = [12, 15, 20, 24, 25, 30, 48, 50, 60, 100, 120, 144, 240].map(
  (n) => [n, rational(n, 1)] as const,
);

/** The fixed rate of a file with fewer than two distinct packet times. */
const SINGLE_FRAME_RATE = rational(25, 1);
/** The rate of a scan estimate outside 5 fps .. `maxFps` (Mux standard input). */
const OUT_OF_RANGE_RATE = rational(30, 1);
const MIN_SCAN_FPS = 5;
/** The rate rule reads `r_frame_rate > 210 with avg < 70` as FFmpeg av_guess_frame_rate does. */
const GUESS_R_ABOVE = 210;
const GUESS_AVG_BELOW = 70;
/** Relative distance from the whole-file mean that sends an unnamed `r_frame_rate` to the scan. */
const UNNAMED_TOLERANCE = 0.001;
/** Share of gaps that must land on the lattice. */
const INLIER_SHARE = 0.98;
/** Trimmed mean: a gap under this many seconds folds into the next one; a gap over the idle bound is left out. */
const MIN_FRAME_SECONDS = 1 / 240;
const IDLE_SECONDS = 0.1;

/**
 * Shotcut-style normalisation of an NTSC rate stored inexactly (Matroska 59.94 reads 19001/317).
 * @param rate - `r_frame_rate` or null.
 * @returns The N/1001 rate it stands for, or the rate unchanged.
 * @throws {never} Pure arithmetic.
 */
function normalizeFrameRate(rate: FrameRate | null): FrameRate | null {
  if (rate === null) return null;
  const fps = valueOf(rate);
  if (roundHalfEven(fps * 1e6) === 23976024) return rational(24000, 1001);
  if (roundHalfEven(fps * 1e5) === 2997003) return rational(30000, 1001);
  if (roundHalfEven(fps * 1e6) === 47952048) return rational(48000, 1001);
  if (roundHalfEven(fps * 1e5) === 5994006) return rational(60000, 1001);
  return rate;
}

/**
 * Whether a rate is an integer or one of the five N/1001 rates.
 * @param rate - The rate.
 * @returns True when named.
 * @throws {never} Pure comparison.
 */
function isNamedRate(rate: FrameRate): boolean {
  return rate.denominator === 1 || NTSC_RATES.some((ntsc) => sameRate(ntsc, rate));
}

/**
 * Adjacent differences.
 * @param ticks - Sorted distinct ticks.
 * @returns The gaps.
 * @throws {never} Pure arithmetic.
 */
function gapsOf(ticks: readonly number[]): number[] {
  return ticks.slice(1).map((t, i) => t - ticks[i]!);
}

/**
 * Snaps a measured rate: N/1001 within 0.05%, else the nearest common integer rate within 2.5%.
 * @param rate - Frames per second.
 * @returns The snapped rate, or null when none is close enough.
 * @throws {never} Pure arithmetic.
 */
export function snapFrameRate(rate: number): FrameRate | null {
  for (const [value, exact] of SPECIAL_RATES) if (Math.abs(value / rate - 1) <= 0.0005) return exact;
  return closestCommonRate(rate);
}

/**
 * The nearest common integer rate within 2.5%.
 * @param rate - Frames per second.
 * @returns The rate, or null.
 * @throws {never} Pure arithmetic.
 */
function closestCommonRate(rate: number): FrameRate | null {
  let best: FrameRate | null = null;
  let bestError = Infinity;
  for (const [value, exact] of COMMON_RATES) {
    const error = Math.abs(value / rate - 1);
    if (error <= 0.025 && error < bestError) {
      best = exact;
      bestError = error;
    }
  }
  return best;
}

/**
 * The median frame rate of adjacent gaps; an even count averages the rates of the middle two gaps.
 * @param ticks - Sorted distinct ticks, at least two.
 * @param ticksPerSecond - Ticks per second.
 * @returns Frames per second.
 * @throws {never} Pure arithmetic.
 */
export function medianFrameRate(ticks: readonly number[], ticksPerSecond: number): number {
  const gaps = gapsOf(ticks).sort((a, b) => a - b);
  const n = gaps.length;
  return (ticksPerSecond / gaps[(n - 1) >> 1]! + ticksPerSecond / gaps[n >> 1]!) / 2;
}

/**
 * The trimmed mean frame rate: a time under 1/240 s after the last counted point is skipped (its gap folds into the
 * next), a gap over 0.1 s is left out, the rest are averaged.
 * @param ticks - Sorted distinct ticks.
 * @param ticksPerSecond - Ticks per second.
 * @returns Counted gaps ÷ their total seconds, or null when no gap counts.
 * @throws {never} Pure arithmetic.
 */
export function trimmedMeanFrameRate(ticks: readonly number[], ticksPerSecond: number): number | null {
  let previous = ticks[0]!;
  let total = 0;
  let count = 0;
  for (const tick of ticks.slice(1)) {
    const seconds = (tick - previous) / ticksPerSecond;
    if (seconds < MIN_FRAME_SECONDS) continue;
    previous = tick;
    if (seconds > IDLE_SECONDS) continue;
    total += seconds;
    count += 1;
  }
  return count > 0 ? count / total : null;
}

/**
 * The simplest fraction strictly between two positive bounds, denominators up to one million.
 * @param low - Lower bound.
 * @param high - Upper bound.
 * @returns It, or null.
 * @throws {never} Pure arithmetic.
 */
function simplestBetween(low: number, high: number): FrameRate | null {
  for (let denominator = 1; denominator <= 1_000_000; denominator += 1) {
    const numerator = Math.floor(low * denominator) + 1;
    if (numerator / denominator < high) return { numerator, denominator };
  }
  return null;
}

/**
 * Share of gaps within `tolerance` of a whole multiple of `period`.
 * @param gaps - Gaps in ticks.
 * @param period - Frame period in ticks.
 * @param tolerance - Allowed distance in ticks.
 * @returns The share.
 * @throws {never} Pure arithmetic.
 */
function landingShare(gaps: readonly number[], period: number, tolerance: number): number {
  const landed = gaps.filter((g) => Math.abs(g - Math.max(1, roundHalfEven(g / period)) * period) < tolerance).length;
  return landed / gaps.length;
}

/**
 * Fits "every gap is a whole multiple of one frame period": iterate the period from the 5th-percentile gap, require 98%
 * of gaps on the lattice, prefer a known rate inside the error range, else the simpler of the fps and period fractions.
 * @param ticks - Sorted distinct ticks, at least two.
 * @param ticksPerSecond - Ticks per second.
 * @returns The fitted rate, or null when the fit fails.
 * @throws {never} Pure arithmetic.
 */
function latticeFrameRate(ticks: readonly number[], ticksPerSecond: FrameRate): FrameRate | null {
  const res = valueOf(ticksPerSecond);
  const gaps = gapsOf(ticks);
  const sorted = [...gaps].sort((a, b) => a - b);
  let period = sorted[Math.floor(sorted.length * 0.05)]!;
  let uncertainty = 1;
  /**
   * Gaps on the lattice of the current period.
   * @returns Their count, total ticks and total frames.
   * @throws {never} Pure arithmetic.
   */
  const inliers = (): { count: number; ticks: number; frames: number } => {
    let count = 0;
    let total = 0;
    let frames = 0;
    for (const g of gaps) {
      const multiple = Math.max(1, roundHalfEven(g / period));
      if (Math.abs(g - multiple * period) >= 1 + 1e-9 + multiple * uncertainty) continue;
      count += 1;
      total += g;
      frames += multiple;
    }
    return { count, ticks: total, frames };
  };
  for (let i = 0; i < 6; i += 1) {
    const fit = inliers();
    if (fit.frames === 0) return null;
    const refined = fit.ticks / fit.frames;
    uncertainty = 1 / Math.min(fit.frames, 1000);
    const settled = Math.abs(refined - period) <= 1e-12 * Math.max(1, period);
    period = refined;
    if (settled) break;
  }
  const fit = inliers();
  if (fit.count / gaps.length < INLIER_SHARE) return null;
  period = fit.ticks / fit.frames;
  const u = 1 / Math.min(fit.frames, 1000);
  const periodLow = Math.max(Number.EPSILON, period - u);
  const periodHigh = period + u;
  const fpsLow = res / periodHigh;
  const fpsHigh = res / periodLow;
  const fitted = res / period;
  let fps: FrameRate | null = null;
  let best = Infinity;
  for (const [value, exact] of KNOWN_RATES) {
    if (fpsLow <= value && value <= fpsHigh && Math.abs(value / fitted - 1) < best) {
      fps = exact;
      best = Math.abs(value / fitted - 1);
    }
  }
  if (fps === null) {
    const periodFraction = simplestBetween(periodLow, periodHigh);
    const fpsFraction = simplestBetween(fpsLow, fpsHigh);
    if (fpsFraction !== null && (periodFraction === null || fpsFraction.denominator < periodFraction.denominator
      || (fpsFraction.denominator === periodFraction.denominator && fpsFraction.numerator <= periodFraction.numerator))) {
      fps = fpsFraction;
    } else if (periodFraction !== null) {
      fps = rational(ticksPerSecond.numerator * periodFraction.denominator, ticksPerSecond.denominator * periodFraction.numerator);
    } else {
      return null;
    }
  }
  return landingShare(gaps, res / valueOf(fps), 1 + 1e-9) >= INLIER_SHARE ? fps : null;
}

/**
 * The packet-scan estimate: lattice fit, then FFmpeg's default-window `r_frame_rate` passing the 1 ms landing check,
 * then the median snapped, replaced by the snapped trimmed mean when that is higher or the median does not snap.
 * @param ticks - Sorted distinct ticks, at least two.
 * @param ticksPerSecond - Ticks per second.
 * @param rFrameRate - Normalised `r_frame_rate`.
 * @param maxFps - Upper bound.
 * @returns The estimate, the exact rate when a step gave one, and the step.
 * @throws {never} Pure arithmetic.
 */
function scanEstimate(
  ticks: readonly number[], ticksPerSecond: FrameRate, rFrameRate: FrameRate | null, maxFps: number,
): { estimate: number; exact: FrameRate | null; step: FrameGridRateStep } {
  const res = valueOf(ticksPerSecond);
  const lattice = latticeFrameRate(ticks, ticksPerSecond);
  if (lattice !== null) return { estimate: valueOf(lattice), exact: lattice, step: "lattice" };
  if (rFrameRate !== null && isNamedRate(rFrameRate) && compareTo(rFrameRate, MIN_SCAN_FPS) >= 0 && compareTo(rFrameRate, maxFps) <= 0
    && landingShare(gapsOf(ticks), res / valueOf(rFrameRate), 1 + res * 0.001) >= INLIER_SHARE) {
    return { estimate: valueOf(rFrameRate), exact: rFrameRate, step: "rFrameRate" };
  }
  const median = medianFrameRate(ticks, res);
  const snapped = snapFrameRate(median);
  const mean = trimmedMeanFrameRate(ticks, res);
  const meanSnapped = mean === null ? null : closestCommonRate(mean);
  if (meanSnapped !== null && (snapped === null || valueOf(meanSnapped) > valueOf(snapped))) {
    return { estimate: valueOf(meanSnapped), exact: meanSnapped, step: "trimmedMean" };
  }
  return { estimate: median, exact: snapped, step: snapped === null ? "rounded" : "medianSnapped" };
}

/**
 * Chooses the frame grid's rate (§4.1 frame rate row): the normalised `r_frame_rate` unless a scan condition holds, else the
 * packet-scan estimate; fewer than two distinct packet times give 25.
 * @param input - The probe facts.
 * @returns The rate, the deciding step and the scan condition.
 * @throws {never} Pure arithmetic.
 */
export function chooseFrameGridRate(input: FrameGridRateInput): FrameGridRate {
  const r = normalizeFrameRate(input.rFrameRate);
  const avg = input.avgFrameRate;
  const res = valueOf(input.ticksPerSecond);
  const ticks = [...new Set(input.ticks)].sort((a, b) => a - b);
  if (ticks.length < 2) return { fps: SINGLE_FRAME_RATE, step: "singleFrame", scanReason: null };
  const mean = (res * (ticks.length - 1)) / (ticks[ticks.length - 1]! - ticks[0]!);
  let scanReason: FrameGridScanReason;
  if (avg === null || compareTo(avg, 0) <= 0) scanReason = "avgInvalid";
  else if (r === null || compareTo(r, input.maxFps) > 0) scanReason = "rOverMax";
  else if (compareTo(r, GUESS_R_ABOVE) > 0 && compareTo(avg, GUESS_AVG_BELOW) < 0) scanReason = "guessAvg";
  else if (!isNamedRate(r) && Math.abs(valueOf(r) - mean) / mean >= UNNAMED_TOLERANCE) scanReason = "rUnnamed";
  else return { fps: r, step: "nominal", scanReason: null };
  const { estimate, exact, step } = scanEstimate(ticks, input.ticksPerSecond, r, input.maxFps);
  if (estimate < MIN_SCAN_FPS || estimate > input.maxFps) return { fps: OUT_OF_RANGE_RATE, step: "outOfRange", scanReason };
  if (exact !== null) return { fps: exact, step, scanReason };
  return { fps: rational(Math.floor(estimate + 0.5), 1), step: "rounded", scanReason };
}

/** What the variable-frame-rate test reads from the probe. */
export interface VariableFrameRateFacts {
  /** Packet `duration` fields in packet order. */
  packetDurations: readonly number[];
  /** `avg_frame_rate`, null for 0/0. */
  avgFrameRate: FrameRate | null;
  /** `r_frame_rate`, null for 0/0. */
  rFrameRate: FrameRate | null;
}

/** What decides whether the original can be the tool source. */
export interface EditFileFacts {
  variableFrameRate: boolean;
  /** ffprobe `color_transfer`, null when untagged. */
  transfer: string | null;
  /** Whether the seek to the grid start succeeded. */
  seekable: boolean;
}

/**
 * MLT's variable-frame-rate test: three or more packet-duration changes in the first 20 video packets, or an average
 * rate whose denominator is outside {0, 1, 2, 125, 1001} and differs from the nominal rate.
 * @param facts - The probe facts.
 * @returns True when the source is variable rate.
 * @throws {never} Pure comparison.
 */
export function isVariableFrameRate(facts: VariableFrameRateFacts): boolean {
  const first = facts.packetDurations.slice(0, 20);
  const changes = first.slice(1).filter((d, i) => d !== first[i]).length;
  if (changes >= 3) return true;
  const avg = facts.avgFrameRate;
  if (avg === null || [0, 1, 2, 125, 1001].includes(avg.denominator)) return false;
  return facts.rFrameRate === null || !sameRate(rational(avg.numerator, avg.denominator), rational(facts.rFrameRate.numerator, facts.rFrameRate.denominator));
}

/**
 * Whether the original cannot serve as the tool source (§4.2): variable rate, HDR (PQ or HLG) or not seekable.
 * @param facts - The probe facts.
 * @returns True when an edit file is needed.
 * @throws {never} Pure comparison.
 */
export function needsEditFile(facts: EditFileFacts): boolean {
  return facts.variableFrameRate || facts.transfer === "smpte2084" || facts.transfer === "arib-std-b67" || !facts.seekable;
}

const ALPHA_LAYER_CODECS = new Set(["vp8", "vp9", "hevc"]);
const DEPTH_KEYED_CODECS = new Set(["h264", "hevc", "vp9", "vp8", "mpeg4"]);
const OTHER_CODECS = new Set(["mjpeg", "mpeg2video", "vc1", "wmv1", "wmv2", "wmv3", "theora", "qtrle"]);
const OWN_KEY_CODECS: ReadonlyMap<string, SourceDecodeKey> = new Map([
  ["prores", "sdr_prores"], ["dnxhd", "sdr_dnx"], ["jpeg2000", "sdr_jpeg2000"], ["ffv1", "sdr_ffv1"], ["png", "sdr_png"],
]);

/**
 * The source decode-rate key (§5.4 estimate row): codec first, then bit depth; an unlisted codec, or a depth-keyed codec
 * over 12 bits, takes the key of smallest value.
 * @param source - Codec, bit depth and transparency classification of the original.
 * @param rates - The decode rates per key, to find the slowest.
 * @returns The key.
 * @throws {never} Pure lookup.
 */
export function sourceDecodeKey(source: DecodeKeySource, rates: Readonly<Record<SourceDecodeKey, number>>): SourceDecodeKey {
  const { codec, bitDepth } = source;
  if (source.alpha === "confirmed_alpha" && ALPHA_LAYER_CODECS.has(codec)) return "sdr_alpha_layer";
  const own = OWN_KEY_CODECS.get(codec);
  if (own !== undefined) return own;
  if (OTHER_CODECS.has(codec)) return "sdr_other";
  if (bitDepth <= 12) {
    if (codec === "av1") return bitDepth <= 8 ? "sdr_av1_8bit" : bitDepth <= 10 ? "sdr_av1_10bit" : "sdr_av1_12bit";
    if (DEPTH_KEYED_CODECS.has(codec)) return bitDepth <= 8 ? "sdr_8bit" : bitDepth <= 10 ? "sdr_10bit" : "sdr_12bit";
  }
  return SOURCE_DECODE_KEYS.reduce((slowest, key) => (rates[key] < rates[slowest] ? key : slowest));
}
