// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation runner's own decisions (inner#1711 design §3.6, §6), the parts that need no Chromium and no
 * model: the Manifest it writes, the font-set stylesheet, how it inlines the runtime, the frame-ready bridge and the
 * stylesheet into the package, the verdict it draws from what Chromium measured, and the environment it starts the
 * DeepSeek Harness in.
 */

import { durationToFrames, type TimelineRate } from "@shared/timeline/time.js";
import { WEB_ANIMATION_RUNTIME } from "@shared/timeline/web-animation-runtime.js";

/** The only families a package may draw text with. */
export const WEB_ANIMATION_FONT_FAMILIES = ["Noto Sans SC", "Noto Serif SC", "Inter"] as const;

/** One family of the font set. */
export type WebAnimationFontFamily = (typeof WEB_ANIMATION_FONT_FAMILIES)[number];

/** One woff2 slice of a family, as the font build lists it. */
export interface WebAnimationFontFace {
  family: string;
  /** The file name without `.woff2`. */
  file: string;
  unicodeRange: string;
  /** The variable weight range, `100 900` when not given. */
  weight?: string;
}

/** What a source's run fixes about its result. */
export interface WebAnimationTarget {
  viewport: { width: number; height: number };
  fps: TimelineRate;
  durationFrames: number;
  fontSetVersion: number;
}

/** The Manifest written beside a package; `WebAnimationManifestSchema` in shared reads it. */
export interface WebAnimationManifestBody {
  schemaVersion: 1;
  entrypoint: "index.html";
  viewport: { width: number; height: number };
  fps: TimelineRate;
  durationFrames: number;
  resources: Array<{ kind: "font-set"; version: number }>;
  runtime: { id: typeof WEB_ANIMATION_RUNTIME.id; version: typeof WEB_ANIMATION_RUNTIME.version };
}

/** What the check expects of a package. */
export interface WebAnimationCheckExpectation {
  viewport: { width: number; height: number };
  fps: TimelineRate;
  durationFrames: number;
  maxPackageBytes: number;
  /** Every request but a `data:` URL must start with this: the font set's directory on the check server. */
  fontRequestPrefix: string;
}

/** What Chromium measured of a loaded package. */
export interface WebAnimationCheckObservation {
  /** The composition's `data-duration`, or null when it is missing or not a number. */
  durationSeconds: number | null;
  /** The composition's `data-width` and `data-height`, or null when either is missing. */
  viewport: { width: number; height: number } | null;
  /** Screenshot hashes of two seeks to the same time. */
  seekRepeat: string[];
  /** Screenshot hashes of a forward and a backward seek to the same time. */
  seekDirections: string[];
  /** The platform fonts CDP reported for every text node. */
  textFonts: Array<{ family: string; isCustomFont: boolean }>;
  /** Every URL the page requested besides itself. */
  requests: string[];
  packageBytes: number;
}

/** Why a package failed its check. */
export type WebAnimationCheckFailure =
  | "duration_unreadable"
  | "duration_mismatch"
  | "viewport_mismatch"
  | "seek_not_repeatable"
  | "seek_direction_mismatch"
  | "font_not_in_set"
  | "external_request"
  | "package_too_large";

/** The key dsh is handed: a placeholder, because the relay outside the container adds the real one. */
const PLACEHOLDER_KEY = "sk-placeholder";

/**
 * The Manifest of a package built for a run.
 * @param target - The run's viewport, frame rate, length and font set.
 * @returns The Manifest.
 * @throws {never} Never.
 */
export function buildWebAnimationManifest(target: WebAnimationTarget): WebAnimationManifestBody {
  return {
    schemaVersion: 1,
    entrypoint: "index.html",
    viewport: { width: target.viewport.width, height: target.viewport.height },
    fps: { num: target.fps.num, den: target.fps.den },
    durationFrames: target.durationFrames,
    resources: [{ kind: "font-set", version: target.fontSetVersion }],
    runtime: { id: WEB_ANIMATION_RUNTIME.id, version: WEB_ANIMATION_RUNTIME.version },
  };
}

/**
 * Whether a family name is one of the set's, as CSS names it or as a platform font reports it (a variable font may
 * report a suffixed name such as `Inter Variable`).
 * @param family - The family name.
 * @returns True for a family of the set.
 * @throws {never} Never.
 */
function inFontSet(family: string): boolean {
  return WEB_ANIMATION_FONT_FAMILIES.some((name) => family === name || family.startsWith(`${name} `));
}

/**
 * The font set's stylesheet: one `@font-face` per slice, each file addressed beside the package under the version's
 * directory, so the preview route's origin serves it.
 * @param version - The font set's version.
 * @param faces - The slices.
 * @returns The stylesheet.
 * @throws {RangeError} When a face names a family outside the set.
 */
export function buildFontSetStylesheet(version: number, faces: WebAnimationFontFace[]): string {
  return faces.map((face) => {
    if (!(WEB_ANIMATION_FONT_FAMILIES as readonly string[]).includes(face.family)) {
      throw new RangeError(`Font family ${face.family} is not in the font set`);
    }
    return `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight ?? "100 900"};` +
      `font-display:block;src:url("../fonts/v${version}/${face.file}.woff2") format("woff2");` +
      `unicode-range:${face.unicodeRange}}`;
  }).join("\n");
}

/**
 * Keep inlined text from ending its element early.
 * @param text - Script or stylesheet text.
 * @param tag - The element it goes into.
 * @returns The text, with every closing tag of that element and every comment opener escaped.
 * @throws {never} Never.
 */
function inlineSafe(text: string, tag: "script" | "style"): string {
  return text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1").replace(/<!--/g, "<\\!--");
}

/**
 * Build the package: the model's composition with the runtime, then the bridge, then the font stylesheet inlined at
 * the end of its head (its body, or its end, when it has none), so the package references no file but the font set
 * and the runtime is loaded before the composition's own scripts run.
 * @param pieces - The composition and the three texts to inline.
 * @param pieces.composition - The composition the model wrote.
 * @param pieces.runtime - The HyperFrames runtime.
 * @param pieces.bridge - The frame-ready bridge.
 * @param pieces.fontStylesheet - The font set's stylesheet.
 * @returns The package's HTML.
 * @throws {never} Never.
 */
export function packWebAnimationSource(pieces: { composition: string; runtime: string; bridge: string; fontStylesheet: string }): string {
  const inlined =
    `<script>\n${inlineSafe(pieces.runtime, "script")}\n</script>\n` +
    `<script>\n${inlineSafe(pieces.bridge, "script")}\n</script>\n` +
    `<style>\n${inlineSafe(pieces.fontStylesheet, "style")}\n</style>\n`;
  const lower = pieces.composition.toLowerCase();
  const head = lower.indexOf("</head>");
  const at = head >= 0 ? head : lower.lastIndexOf("</body>");
  if (at < 0) return `${pieces.composition}\n${inlined}`;
  return `${pieces.composition.slice(0, at)}${inlined}${pieces.composition.slice(at)}`;
}

/**
 * The frame count a `data-duration` gives at the run's frame rate.
 * @param seconds - The duration.
 * @param fps - The frame rate.
 * @returns The frames, or null when the duration is not a positive number.
 * @throws {never} Never.
 */
function framesOf(seconds: number, fps: TimelineRate): number | null {
  try {
    return durationToFrames(seconds, fps);
  } catch {
    // Zero, negative or non-finite: not a duration at all.
    return null;
  }
}

/**
 * Judge what Chromium measured of a package.
 * @param seen - The measurements.
 * @param expected - What the run asked for.
 * @returns Null when the package passes, otherwise the first rule it breaks.
 * @throws {never} Never.
 */
export function judgeWebAnimationCheck(
  seen: WebAnimationCheckObservation,
  expected: WebAnimationCheckExpectation,
): WebAnimationCheckFailure | null {
  const frames = seen.durationSeconds === null ? null : framesOf(seen.durationSeconds, expected.fps);
  if (frames === null) return "duration_unreadable";
  if (frames !== expected.durationFrames) return "duration_mismatch";
  if (seen.viewport === null || seen.viewport.width !== expected.viewport.width || seen.viewport.height !== expected.viewport.height) {
    return "viewport_mismatch";
  }
  if (seen.seekRepeat.length < 2 || new Set(seen.seekRepeat).size !== 1) return "seek_not_repeatable";
  if (seen.seekDirections.length < 2 || new Set(seen.seekDirections).size !== 1) return "seek_direction_mismatch";
  if (seen.textFonts.some((font) => !font.isCustomFont || !inFontSet(font.family))) return "font_not_in_set";
  if (seen.requests.some((url) => !url.startsWith("data:") && !url.startsWith(expected.fontRequestPrefix))) return "external_request";
  if (seen.packageBytes > expected.maxPackageBytes) return "package_too_large";
  return null;
}

/**
 * The environment the DeepSeek Harness runs in: what the runner passes on, plus dsh's own settings pointing it at
 * `model.local` with a placeholder key, telemetry off and full permissions inside the container, which is the
 * isolation boundary.
 * @param base - What the runner passes on.
 * @param base.HOME - The harness's home.
 * @param base.PATH - Where it finds programs.
 * @returns The environment.
 * @throws {never} Never.
 */
export function webAnimationDshEnv(base: { HOME: string; PATH: string }): Record<string, string> {
  return {
    HOME: base.HOME,
    PATH: base.PATH,
    DSH_HOME: `${base.HOME}/.dsh`,
    DEEPSEEK_BASE_URL: "http://model.local",
    DEEPSEEK_API_KEY: PLACEHOLDER_KEY,
    DSH_TELEMETRY_MODE: "DISABLED",
    DSH_PERMISSION_MODE: "danger-full-access",
  };
}
