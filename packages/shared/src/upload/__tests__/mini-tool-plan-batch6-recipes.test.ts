// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 D15-5 to D15-8 (frames-split §7.17 recipe table and 转场输出档 row, §5.4; execution design §8.1):
 * the recipe shapes of the transition export and the erase/expand composite, built from the existing recipe parts in
 * `mini-tool-plan-job.ts` (source/empty entries, `windowRecipe`, the audio entry, `{ start, end }` ordinal windows, exact
 * times); recipes name bound job inputs by `inputId`, never storage keys. The shapes chosen here are recorded in §97.
 *
 * - The transition output profile: `{ width, height, fps, timeBase, pixFmt, color, codec, encode: { crf, preset }, alpha }`;
 *   timeBase is 1/fps, alpha goes with vp9 and yuva420p, no alpha with h264 and yuv420p, and h264 has even sides.
 * - `transition_window`: `{ kind, clips: [two { inputId, entries, colorMatrix, toneMap, fit }], frames, window: { startFrame,
 *   frameCount }, transition, profile }`; `frames` is the chunk's [k0, k1) on the output grid and lies inside the window.
 *   Each clip carries its own source conversion (frames-split §4.3 colour/HDR row): the decode matrix its plan resolved and
 *   `toneMap: "sdr-bt709"` for an HDR source, the same two fields and values the `segment`/`chunk_encode` target and the
 *   `scene_cuts` analysis target carry, because the profile is the output's and both clips decode into it.
 * - `chunk_encode` gains an optional `profile`.
 * - The transition `stitch`: `{ kind, chunks, clips: [two { inputId, audio }], crossfade: { startFrame, frameCount } | null,
 *   profile }`; `audio` is the existing audio entry, null for a clip without audio (silence over its span); `crossfade` is
 *   null for a Cut.
 * - `model_composite`, by `mode`: erase `{ ...windowRecipe, result, rle, table, range, grid, matte }` (execution design §10.4); expand `{ ...windowRecipe, backgrounds:
 *   [{ inputId, window }] }`, whose own `window` is that window's presentation interval, in order.
 */
import { describe, expect, it } from "vitest";
import { miniToolPlanJobReportSchema, miniToolPlanJobRequestSchema, miniToolPlanRecipeSchema } from "@shared/upload/mini-tool-plan-job.js";

type Recipe = Record<string, unknown>;
const r = (numerator: number, denominator = 1): { numerator: string; denominator: string } => {
  let [a, b] = [numerator, denominator]; while (b !== 0) [a, b] = [b, a % b];
  return { numerator: String(numerator / a), denominator: String(denominator / a) };
};
const SOURCE_A = "20000000-0000-4000-8000-000000000001";
const SOURCE_B = "20000000-0000-4000-8000-000000000002";
const CHUNK = "20000000-0000-4000-8000-0000000000c0";
const RESULT = "20000000-0000-4000-8000-0000000000e0";
const BACKGROUNDS = ["20000000-0000-4000-8000-0000000000b0", "20000000-0000-4000-8000-0000000000b1"];
const UNBOUND = "20000000-0000-4000-8000-0000000000ff";
const RLE = "20000000-0000-4000-8000-0000000000d0";
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
/** The source entry of presented frame `n` of a 25 fps clip. @returns It. */
const entryAt = (n: number, count = 1): Recipe => ({ kind: "source", decodeStart: r(n, 25), clipStart: r(n, 25), displayStart: r(n, 25), displayEnd: r(n + count, 25), rate: r(1) });
const OPAQUE = { width: 320, height: 180, fps: r(25), timeBase: r(1, 25), pixFmt: "yuv420p", color: { matrix: "bt709", range: "tv", primaries: "bt709", transfer: "bt709" }, codec: "h264", encode: { crf: 18, preset: "medium" }, alpha: false };
const TRANSPARENT = { ...OPAQUE, width: 97, pixFmt: "yuva420p", codec: "vp9", alpha: true };
const TARGET = { width: 320, height: 180, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium", format: "mp4-h264" };
const AUDIO = { start: r(0), end: r(3), origin: r(0), spans: null };

const SDR = { colorMatrix: "bt709", toneMap: "none" };
const HDR = { colorMatrix: "bt2020nc", toneMap: "sdr-bt709" };
// Each clip sits in its fitted rectangle on the 320x180 output (`transitionFitRect`).
const FIT = { x: 0, y: 0, width: 320, height: 180 };
const windowClips = (): Recipe[] => [{ inputId: SOURCE_A, entries: [entryAt(75, 15)], ...HDR, fit: FIT }, { inputId: SOURCE_B, entries: [entryAt(0, 15)], ...SDR, fit: FIT }];
const windowChunk = (): Recipe => ({
  kind: "transition_window", clips: windowClips(),
  frames: { start: 75, end: 90 }, window: { startFrame: 75, frameCount: 15 }, transition: "fade", profile: OPAQUE,
});
const encodeChunk = (): Recipe => ({ kind: "chunk_encode", inputId: SOURCE_A, window: { start: 0, end: 25 }, timescale: 25, entries: [entryAt(0, 25)], target: TARGET });
const stitchClips = (): Recipe[] => [{ inputId: SOURCE_A, audio: AUDIO }, { inputId: SOURCE_B, audio: null }];
const transitionStitch = (): Recipe => ({
  kind: "stitch", chunks: [{ inputId: CHUNK, duration: r(39, 5) }],
  clips: stitchClips(), crossfade: { startFrame: 75, frameCount: 15 }, profile: OPAQUE,
});
const windowShape = { inputId: SOURCE_A, window: { start: 0, end: 50 }, timescale: 25, entries: [entryAt(0, 50)], target: TARGET };
const erase = (): Recipe => ({ kind: "model_composite", mode: "erase", ...windowShape, result: RESULT, rle: RLE,
  table: { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 50, step: 1, duration: 1 }] }, range: { startFrame: 13, frameCount: 25 },
  grid: { mode: "frames", rate: 25, frameCount: 25 }, matte: { dilate: 4, feather: 4 }, rleSize: { width: 320, height: 180 } });
const expand = (): Recipe => ({
  kind: "model_composite", mode: "expand", ...windowShape,
  backgrounds: [{ inputId: BACKGROUNDS[0], window: { start: r(0), end: r(5, 4) } }, { inputId: BACKGROUNDS[1], window: { start: r(1), end: r(2) } }],
});

/**
 * A copy of a recipe with each dotted path set to its value; `undefined` deletes the key.
 * @param recipe - The control.
 * @param edits - Path to new value.
 * @returns The copy.
 * @throws {Error} When a fixture path is wrong.
 */
function changed(recipe: Recipe, edits: Record<string, unknown>): Recipe {
  const copy = structuredClone(recipe);
  for (const [path, value] of Object.entries(edits)) {
    const parts = path.split(".");
    let parent: object = copy;
    for (const part of parts.slice(0, -1)) {
      const next: unknown = Reflect.get(parent, part);
      if (typeof next !== "object" || next === null) throw new Error(`Invalid fixture path ${path}`);
      parent = next;
    }
    if (value === undefined) Reflect.deleteProperty(parent, parts.at(-1)!);
    else Reflect.set(parent, parts.at(-1)!, structuredClone(value));
  }
  return copy;
}

/**
 * A planned job request with one output and the given inputs bound.
 * @param recipe - The output recipe.
 * @param bound - The bound input ids.
 * @returns The request.
 */
function job(recipe: Recipe, bound: readonly string[]): Recipe {
  return {
    schemaVersion: 2, jobId: "T:out:0:win:0:a1", containerClass: "MiniToolContainerGl", deadlineAt: Date.parse("2026-11-06T10:00:00Z"), limits: LIMITS,
    inputs: bound.map((inputId, at) => ({ inputId, storageKey: `fixtures/input-${at}.mp4` })),
    outputs: [{ outputIndex: 0, storageKey: "results/T/out-0-win-0.mp4", contentType: "video/mp4", recipe }],
  };
}

/**
 * Assert a valid control parses unchanged and a change of it is refused.
 * @param control - The valid recipe.
 * @param bad - The changed recipe.
 */
function refuses(control: Recipe, bad: Recipe): void {
  expect(miniToolPlanRecipeSchema.parse(control)).toEqual(control);
  expect(miniToolPlanRecipeSchema.safeParse(bad).success).toBe(false);
}

describe("the transition output profile inside recipes (§97 D15-5)", () => {
  it.each([["opaque", OPAQUE], ["transparent", TRANSPARENT]])("BR01 a window chunk carries the %s profile unchanged", (_name, profile) => {
    const recipe = changed(windowChunk(), { profile });
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it.each([
    ["h264 with alpha", { ...OPAQUE, alpha: true }],
    ["vp9 without alpha", { ...TRANSPARENT, alpha: false }],
    ["yuva420p on h264", { ...OPAQUE, pixFmt: "yuva420p" }],
    ["yuv420p with alpha", { ...TRANSPARENT, pixFmt: "yuv420p" }],
    ["an odd h264 side", { ...OPAQUE, width: 321 }],
    ["a time base that is not 1/fps", { ...OPAQUE, timeBase: r(1, 30) }],
    ["a full-range colour", { ...OPAQUE, color: { ...OPAQUE.color, range: "pc" } }],
    ["a non-BT.709 transfer", { ...OPAQUE, color: { ...OPAQUE.color, transfer: "smpte2084" } }],
    ["no encode settings", { ...OPAQUE, encode: undefined }],
    ["an unknown preset", { ...OPAQUE, encode: { crf: 18, preset: "placebo" } }],
  ])("BR02 refuses a profile with %s", (_name, profile) => {
    refuses(windowChunk(), changed(windowChunk(), { profile }));
  });
});

describe("transition_window (§97 D15-6; frames-split §7.17)", () => {
  it("BW01 accepts a window chunk of two clips inside the window", () => {
    expect(miniToolPlanRecipeSchema.parse(windowChunk())).toEqual(windowChunk());
    const tail = changed(windowChunk(), { frames: { start: 80, end: 90 }, transition: "wipeRight" });
    expect(miniToolPlanRecipeSchema.parse(tail)).toEqual(tail);
  });

  it.each([
    ["one clip", { clips: [windowClips()[0]] }],
    ["three clips", { clips: [...windowClips(), windowClips()[0]] }],
    ["a clip without entries", { "clips.1.entries": [] }],
    ["frames before the window", { frames: { start: 74, end: 90 } }],
    ["frames past the window", { frames: { start: 75, end: 91 } }],
    ["empty frames", { frames: { start: 80, end: 80 } }],
    ["a zero-frame window", { window: { startFrame: 75, frameCount: 0 } }],
    ["a Cut", { transition: "cut" }],
    ["no profile", { profile: undefined }],
    ["a segment target instead of the profile", { profile: undefined, target: TARGET }],
  ])("BW02 refuses %s", (_name, edits) => {
    refuses(windowChunk(), changed(windowChunk(), edits));
  });

  it("BW04 each clip carries its own conversion: an HDR clip tone mapped with its plan matrix beside an SDR clip (§4.3)", () => {
    const parsed = miniToolPlanRecipeSchema.parse(windowChunk()) as { clips: Recipe[] };
    expect(parsed.clips.map(({ colorMatrix, toneMap }) => ({ colorMatrix, toneMap }))).toEqual([HDR, SDR]);
  });

  it.each([
    ["a clip without its matrix", { "clips.0.colorMatrix": undefined }],
    ["a clip without its tone mapping", { "clips.0.toneMap": undefined }],
    ["a clip without its fitted rectangle", { "clips.0.fit": undefined }],
    ["an empty matrix", { "clips.1.colorMatrix": "" }],
    ["an unknown tone mapping", { "clips.0.toneMap": "hdr10" }],
    ["one conversion for the whole window instead of per clip", { "clips.0.colorMatrix": undefined, "clips.0.toneMap": undefined, "clips.1.colorMatrix": undefined, "clips.1.toneMap": undefined, colorMatrix: "bt709", toneMap: "none" }],
  ])("BW05 refuses %s", (_name, edits) => {
    refuses(windowChunk(), changed(windowChunk(), edits));
  });

  it("BW03 a job binds both clip inputs; a clip on an unbound input is refused", () => {
    expect(miniToolPlanJobRequestSchema.safeParse(job(windowChunk(), [SOURCE_A, SOURCE_B])).success).toBe(true);
    expect(miniToolPlanJobRequestSchema.safeParse(job(windowChunk(), [SOURCE_A])).success).toBe(false);
  });
});

describe("chunk_encode with the transition profile (§97 D15-7)", () => {
  it("BC01 accepts an encode chunk with the profile and its output frames and keeps one without either", () => {
    const withProfile = { ...encodeChunk(), profile: OPAQUE, frames: { start: 0, end: 30 } };
    expect(miniToolPlanRecipeSchema.parse(withProfile)).toEqual(withProfile);
    expect(miniToolPlanRecipeSchema.parse(encodeChunk())).toEqual(encodeChunk());
  });

  it("BC02 refuses an encode chunk with an invalid profile", () => {
    const control = { ...encodeChunk(), profile: OPAQUE, frames: { start: 0, end: 30 } };
    refuses(control, { ...control, profile: { ...OPAQUE, alpha: true } });
  });

  // The output grid is the profile's, so a clip at another rate covers a different number of output frames than source frames.
  it.each([
    ["the profile without its output frames", { ...encodeChunk(), profile: OPAQUE }],
    ["output frames without the profile", { ...encodeChunk(), frames: { start: 0, end: 30 } }],
    ["empty output frames", { ...encodeChunk(), profile: OPAQUE, frames: { start: 30, end: 30 } }],
  ])("BC03 refuses %s", (_name, bad) => {
    expect(miniToolPlanRecipeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("the transition stitch (§97 D15-7; frames-split §7.17 stitch row)", () => {
  it("BS01 accepts the two clips' audio entries with a crossfade, a silent clip and a Cut", () => {
    expect(miniToolPlanRecipeSchema.parse(transitionStitch())).toEqual(transitionStitch());
    const cut = changed(transitionStitch(), { crossfade: null, "clips.1.audio": AUDIO });
    expect(miniToolPlanRecipeSchema.parse(cut)).toEqual(cut);
  });

  it.each([
    ["one clip", { clips: [stitchClips()[0]] }],
    ["a zero-frame crossfade", { crossfade: { startFrame: 75, frameCount: 0 } }],
    ["no profile", { profile: undefined }],
    ["the single-source audio beside the clips", { audio: AUDIO }],
    ["a chunk on a clip input", { chunks: [{ inputId: SOURCE_A, duration: r(39, 5) }] }],
  ])("BS02 refuses %s", (_name, edits) => {
    refuses(transitionStitch(), changed(transitionStitch(), edits));
  });

  it("BS03 a job binds the chunks and both clips; an unbound clip is refused", () => {
    expect(miniToolPlanJobRequestSchema.safeParse(job(transitionStitch(), [CHUNK, SOURCE_A, SOURCE_B])).success).toBe(true);
    expect(miniToolPlanJobRequestSchema.safeParse(job(transitionStitch(), [CHUNK, SOURCE_A])).success).toBe(false);
  });
});

describe("model_composite (§97 D15-8; frames-split §7.17, execution design §8.1)", () => {
  it.each([["erase", erase], ["expand", expand]] as const)("BM01 accepts the %s composite chunk", (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.parse(recipe())).toEqual(recipe());
  });

  it.each([
    ["an unknown mode", erase, { mode: "inpaint" }],
    ["erase without its result", erase, { result: undefined }],
    ["erase with an empty range", erase, { range: { startFrame: 13, frameCount: 0 } }],
    ["erase without its mask", erase, { rle: undefined }],
    ["erase without its grid", erase, { grid: undefined }],
    ["erase with expand's backgrounds", erase, { backgrounds: expand().backgrounds }],
    ["expand with erase's result", expand, { result: RESULT }],
    ["expand without backgrounds", expand, { backgrounds: [] }],
    // The container blends each frame from the windows' own intervals, so a recipe carries no consumption ledger.
    ["expand with a ledger", expand, { ledger: [{ overlap: r(0), consumed: { start: r(0), end: r(9, 8) } }, { overlap: r(1, 4), consumed: { start: r(9, 8), end: r(2) } }] }],
    ["backgrounds out of order", expand, { backgrounds: [...(expand().backgrounds as unknown[])].reverse() }],
    ["no segment target", erase, { target: undefined }],
  ] as const)("BM02 refuses %s", (_name, recipe, edits) => {
    refuses(recipe(), changed(recipe(), edits));
  });

  it("BM03 a job binds the source and every model result; an unbound result or background is refused", () => {
    expect(miniToolPlanJobRequestSchema.safeParse(job(erase(), [SOURCE_A, RESULT, RLE])).success).toBe(true);
    expect(miniToolPlanJobRequestSchema.safeParse(job(erase(), [SOURCE_A, RESULT])).success).toBe(false);
    expect(miniToolPlanJobRequestSchema.safeParse(job(expand(), [SOURCE_A, ...BACKGROUNDS])).success).toBe(true);
    expect(miniToolPlanJobRequestSchema.safeParse(job(expand(), [SOURCE_A, BACKGROUNDS[0]!, UNBOUND])).success).toBe(false);
  });
});

// inner#1306 test plan §97 D17-7 (a), D18-3 (execution design §9.4 no_face row; frames-split §7.17 lipsync_faces row): the
// `lipsync_faces` container reads the person's track and ends its job as failed with one of two reasons: `empty_foreground`
// when the track has no foreground over the used range, `no_face` when there is foreground but no face in any frame.
describe("the lip-sync faces container failures (§97 D17-7, D18-3)", () => {
  it.each(["empty_foreground", "no_face"])("NF01 a failed job report may give %s as its reason", (reason) => {
    const report = { schemaVersion: 2, state: "failed", outputs: [], reason, usage: { wallMs: 1000, cpuUsec: null } };
    expect(miniToolPlanJobReportSchema.safeParse({ ...report, reason: "tool_failed" }).success).toBe(true);
    expect(miniToolPlanJobReportSchema.safeParse(report).success).toBe(true);
  });
});

// The lip-sync clip and composite carry their plan's frozen encode and face feather (execution design §9.2, §9.3): the clip
// is encoded at the plan's container encode, as the composite's target is, and the composite feathers each face's edge by
// the fraction admission froze from config/mini-tools.yaml.
describe("the lip-sync clip encode and composite feather", () => {
  const TABLE = { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 50, step: 1, duration: 1 }] };
  const TIMELINE = { duration: 2, videoDuration: 2, syncMode: "cut_off" };
  const clip = (): Recipe => ({ kind: "lipsync_clip", inputId: SOURCE_A, faces: SOURCE_B, track: RLE, cropSize: 512, timeline: TIMELINE, table: TABLE, encode: { crf: 18, preset: "medium" } });
  const composite = (): Recipe => ({ kind: "lipsync_composite", ...windowShape, timeline: TIMELINE, table: TABLE,
    persons: [{ result: RESULT, faces: SOURCE_B, track: RLE, cropSize: 512 }], rawDiskBytes: 1_000_000, feather: 0.1,
    prepared: { width: 854, height: 480, displayRect: { x: 0, y: 0, width: 853, height: 480 } } });

  it.each([
    ["without an encode", { encode: undefined }], ["with a crf above 51", { "encode.crf": 52 }], ["with an unknown preset", { "encode.preset": "fastest" }],
  ])("LR01 refuses a clip %s", (_name, edits) => {
    refuses(clip(), changed(clip(), edits));
  });

  it.each([
    ["without a feather", { feather: undefined }], ["with a negative feather", { feather: -0.1 }], ["with a feather above 1", { feather: 1.5 }],
  ])("LR02 refuses a composite %s", (_name, edits) => {
    refuses(composite(), changed(composite(), edits));
  });

  // §5.3 model-input row: the composite reads every track and face table in the prepared video's pixels.
  it.each([
    ["without the prepared geometry", { prepared: undefined }], ["with a picture rectangle outside the prepared video", { "prepared.displayRect.width": 855 }],
  ])("LR03 refuses a composite %s", (_name, edits) => {
    refuses(composite(), changed(composite(), edits));
  });
});
