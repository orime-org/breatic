// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { LipsyncTimeline } from "@shared/mini-tools/lipsync-timeline.js";
import type { VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";

/** Finite JSON is validated at admission; the container consumes only owned data types. */
type PlanJsonValue = string | number | boolean | null | PlanJsonValue[] | { [key: string]: PlanJsonValue };

/** Detector identity and effective parameters frozen when its analysis is accepted. */
export interface MiniToolPlanDetectorProfile {
  id: string;
  version: string;
  weightsHash: string | null;
  params: Record<string, PlanJsonValue>;
}

/** A nonempty integer rectangle in one selected frame's actual pixel grid. */
export interface MiniToolPlanPixelRect { x: number; y: number; width: number; height: number }
/** The original display geometry that owns a detector's saved pixel rectangle. */
export interface MiniToolPlanFrameCrop { sourceWidth: number; sourceHeight: number; rect: MiniToolPlanPixelRect }

/** An exact reduced rational time or rate. */
export interface MiniToolPlanExact { numerator: string; denominator: string }
/** An interval of exact times. */
export interface MiniToolPlanInterval { start: MiniToolPlanExact; end: MiniToolPlanExact }
/** One edit of the audio track: media [sourceStart, sourceEnd) shown from presentationStart at rate. */
export interface MiniToolPlanEditSpan { sourceStart: MiniToolPlanExact; sourceEnd: MiniToolPlanExact; presentationStart: MiniToolPlanExact; rate: MiniToolPlanExact }
/**
 * The audio a recipe carries (§91 D3b-11): its presentation interval, the plan's origin and audio spans; with spans the
 * media samples are placed by them, without (no audio edit) presentation time is movie time less the origin.
 */
export interface MiniToolPlanAudio extends MiniToolPlanInterval { origin: MiniToolPlanExact; spans: MiniToolPlanEditSpan[] | null }
/**
 * One presentation entry of a window (§7.17): a source clip span, decoded from its keyframe at `decodeStart` and shown from
 * `clipStart` over its presentation interval at `rate`, the last frame held to `displayEnd`; or a derived-empty frame. On an
 * output grid, `conform` is the exact frame grid in source time the stored frame times of a rounding clock snap to.
 */
export type MiniToolPlanEntry =
  | { kind: "source"; decodeStart: MiniToolPlanExact; clipStart: MiniToolPlanExact; displayStart: MiniToolPlanExact; displayEnd: MiniToolPlanExact; rate: MiniToolPlanExact; conform?: { origin: MiniToolPlanExact; period: MiniToolPlanExact } }
  | { kind: "empty"; fill: "black" | "transparent"; window: MiniToolPlanInterval };
/** The carrier an encode writes (§91 D-2): even coded size, where the picture sits, the plan matrix and conversion. */
export interface MiniToolPlanTarget {
  width: number;
  height: number;
  displayRect: MiniToolPlanPixelRect | null;
  colorMatrix: string;
  toneMap: "none" | "sdr-bt709";
  /** `packed` for an alpha carrier; `straight` for a transparent VP9 split output. */
  alpha: "none" | "packed" | "straight";
  crf: number;
  preset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
  /** A split output's container and codec (§91 D4-4); a carrier and a model input have none. */
  format?: "mp4-h264" | "webm-vp9";
}
/** A presentation window's frames, on its own clock of `1/timescale` from 0. */
interface MiniToolPlanWindowRecipe {
  inputId: string;
  window: { start: number; end: number };
  timescale: number;
  entries: MiniToolPlanEntry[];
  target: MiniToolPlanTarget;
}

/** A still frame's PNG (§91 D4-3): display geometry, the plan's matrix and conversion, the PNG depth and whether alpha is kept. */
export interface MiniToolPlanFrameTarget {
  width: number;
  height: number;
  colorMatrix: string;
  toneMap: "none" | "sdr-bt709";
  pngBitDepth: 8 | 16;
  alpha: "none" | "straight";
}

/** A scene-cut entry with the presentation ordinal of its first frame (§91 D4-5). */
export type MiniToolPlanPlacedEntry = MiniToolPlanEntry & { ordinalOffset: number };
/** An analysis picture's target: display geometry and the plan's colour conversion. */
export interface MiniToolPlanAnalysisTarget { width: number; height: number; colorMatrix: string; toneMap: "none" | "sdr-bt709" }

/** Media recipes shared with a container that loads no validation libraries. */
export type MiniToolPlanRecipe =
  // The frame one full-ledger entry presents (§7.17 frame row), optionally cropped in its display geometry.
  | { kind: "frame"; inputId: string; entry: MiniToolPlanEntry; target: MiniToolPlanFrameTarget; crop?: MiniToolPlanFrameCrop }
  // The split segment, the people anchor and the scanned scene window on full-ledger entries (§91 D4-4, D4-5).
  | ({ kind: "segment"; audio: MiniToolPlanAudio | null } & MiniToolPlanWindowRecipe)
  | { kind: "people"; inputId: string; entry: MiniToolPlanEntry; target: MiniToolPlanFrameTarget; profile: MiniToolPlanDetectorProfile }
  | { kind: "scene_cuts"; inputId: string; window: { start: number; end: number }; timescale: number; profile: MiniToolPlanDetectorProfile;
    entries: MiniToolPlanPlacedEntry[]; target: MiniToolPlanAnalysisTarget }
  /** The video is packet-copied; the audio is copied, encoded to AAC over the stitch's audio entries, or absent (§7.17). */
  | { kind: "copy_carrier"; inputId: string; colorMatrix: string; audio: { kind: "copy" } | ({ kind: "encode" } & MiniToolPlanAudio) | null }
  // A transition chunk carries the profile and the output frames it covers on the profile's grid, both or neither.
  | ({ kind: "chunk_encode"; profile?: MiniToolPlanTransitionProfile; frames?: { start: number; end: number } } & MiniToolPlanWindowRecipe)
  | MiniToolPlanStitch
  | MiniToolPlanTransitionStitch
  // `order` plays the window backwards for a reversed tracking clip; `grid` times the frames for the erase model (§10.2, §10.4).
  | ({ kind: "prepare_model_input"; audio: MiniToolPlanAudio | null; order?: "forward" | "reverse"; grid?: MiniToolPlanModelGrid } & MiniToolPlanWindowRecipe)
  | MiniToolPlanTransitionWindow
  | MiniToolPlanEraseComposite
  | MiniToolPlanExpandComposite
  | MiniToolPlanRleJoin
  | MiniToolPlanBriaMask
  | MiniToolPlanModelWindow
  | MiniToolPlanModelWindowMask
  | MiniToolPlanFrameAt
  | MiniToolPlanLipsyncFaces
  | MiniToolPlanLipsyncClip
  | MiniToolPlanLipsyncStem
  | MiniToolPlanLipsyncComposite;

/** Every person's stem summed sample by sample over the result, from its start (§7.17 stitch row for lip-sync, §97 D22-3). */
export interface MiniToolPlanStemMix { kind: "mix"; inputs: string[] }
/** Chunks joined by stream copy, the source's interval audio or the lip-sync stems' sum encoded once (§5.4). */
export interface MiniToolPlanStitch {
  kind: "stitch"; inputId: string; chunks: { inputId: string; duration: MiniToolPlanExact }[]; audio: MiniToolPlanAudio | MiniToolPlanStemMix | null; target: MiniToolPlanTarget;
}
/** The one output profile both clips of a transition are encoded to (frames-split §7.17, §97 D15-5). */
export interface MiniToolPlanTransitionProfile {
  width: number; height: number; fps: MiniToolPlanExact; timeBase: MiniToolPlanExact; pixFmt: "yuv420p" | "yuva420p";
  color: { matrix: "bt709"; range: "tv"; primaries: "bt709"; transfer: "bt709" }; codec: "h264" | "vp9";
  encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; alpha: boolean;
}
/** A transition's chunks joined in timeline order, each clip's audio placed over its span and crossfaded over the window (§97 D15-7). */
export interface MiniToolPlanTransitionStitch {
  kind: "stitch"; chunks: { inputId: string; duration: MiniToolPlanExact }[];
  /** Each clip's audio over its span, null for a clip without audio (silence over its span). */
  clips: [{ inputId: string; audio: MiniToolPlanAudio | null }, { inputId: string; audio: MiniToolPlanAudio | null }];
  /** The overlap window the two audio tracks cross over, null for a Cut. */
  crossfade: { startFrame: number; frameCount: number } | null;
  profile: MiniToolPlanTransitionProfile;
}
/** One clip of a transition window: its entries and the matrix and tone mapping of its own plan (§97 D23-4). */
export interface MiniToolPlanWindowClip { inputId: string; entries: MiniToolPlanEntry[]; colorMatrix: string; toneMap: "none" | "sdr-bt709" }
/** One chunk `frames` of a transition's overlap window, composed from both clips' entries (§97 D15-6). */
export interface MiniToolPlanTransitionWindow {
  kind: "transition_window";
  /** Each clip's entries and its own plan's conversion, applied before the blend. */
  clips: [MiniToolPlanWindowClip, MiniToolPlanWindowClip];
  frames: { start: number; end: number };
  window: { startFrame: number; frameCount: number };
  transition: "fade" | "wipeLeft" | "wipeRight";
  profile: MiniToolPlanTransitionProfile;
}
/** The erase model's frame grid (execution design §10.4): frame for frame at `rate`, or resampled on a `rate` grid. */
export interface MiniToolPlanModelGrid { mode: "frames" | "resample"; rate: number; frameCount: number }
/** A range of presentation frame ordinals by its first frame and count. */
export interface MiniToolPlanFrameRange { startFrame: number; frameCount: number }
/**
 * An erase composite chunk (execution design §10.4 composite row): each range frame shows its grid slot's result frame through
 * the RLE mask, dilated and feathered in source pixels; `table` places the chunk's first frame in the range.
 */
export type MiniToolPlanEraseComposite = {
  kind: "model_composite"; mode: "erase"; result: string; rle: string; table: VideoPresentationTable; range: MiniToolPlanFrameRange;
  grid: MiniToolPlanModelGrid; matte: { dilate: number; feather: number };
  /** The RLE's frame size: the tracking clips' coded size, which can differ from this chunk's target by the even rounding. */
  rleSize: { width: number; height: number };
} & MiniToolPlanWindowRecipe;
/** The forward and reversed tracking clips' RLE joined over the range (execution design §10.2). */
export interface MiniToolPlanRleJoin { kind: "rle_join"; inputs: { inputId: string; order: "forward" | "reverse"; frameCount: number }[]; width: number; height: number }
/** The erase model's mask video: one lossless full-range frame per grid slot, white where its RLE frame has foreground (§10.4). */
export interface MiniToolPlanBriaMask {
  kind: "bria_mask"; inputId: string; table: VideoPresentationTable; range: MiniToolPlanFrameRange; grid: MiniToolPlanModelGrid; target: { width: number; height: number };
}
/** The expand model's frame grid for one window: `frameCount` frames at `fps` from the span's start (§10.5). */
export interface MiniToolPlanWindowGrid { fps: number; frameCount: number }
/** One expand window's model input (§10.5): each grid slot's covering frame scaled into `sourceRoi` over `fill`, lossless. */
export type MiniToolPlanModelWindow = {
  kind: "model_window"; grid: MiniToolPlanWindowGrid; frame: { width: number; height: number }; sourceRoi: MiniToolPlanPixelRect;
  fill: [number, number, number]; span: MiniToolPlanInterval;
} & MiniToolPlanWindowRecipe;
/** One expand window's mask: black inside `sourceRoi`, white elsewhere, lossless full range (§10.5). */
export interface MiniToolPlanModelWindowMask { kind: "model_window_mask"; grid: MiniToolPlanWindowGrid; frame: { width: number; height: number }; sourceRoi: MiniToolPlanPixelRect; span: MiniToolPlanInterval }
/** The PNG of a video's frame closest to `time`, the earlier on a tie (§10.5 condition step). */
export interface MiniToolPlanFrameAt { kind: "frame_at"; inputId: string; time: MiniToolPlanExact; target: { width: number; height: number } }
/** An expand composite chunk: the background windows, in order, that cover it (§97 D15-8, execution design §8.1). */
export type MiniToolPlanExpandComposite = {
  kind: "model_composite"; mode: "expand";
  /** Each window's model output; `crop` names the product ROI in the output's own pixels when it is a whole model frame (§97 D20-2). */
  backgrounds: { inputId: string; window: MiniToolPlanInterval; crop?: MiniToolPlanPixelRect }[];
} & MiniToolPlanWindowRecipe;

/** One person's face per prepared frame (§7.17 lipsync_faces row): detected on the whole frame, kept inside the person's track. */
export interface MiniToolPlanLipsyncFaces { kind: "lipsync_faces"; inputId: string; track: string; profile: MiniToolPlanDetectorProfile }
/** One person's face clip on the result timeline (§7.17 lipsync_clip row): each result frame's source face, cropped and fitted. */
export interface MiniToolPlanLipsyncClip {
  kind: "lipsync_clip"; inputId: string; faces: string; track: string; cropSize: number; timeline: LipsyncTimeline; table: VideoPresentationTable;
  /** The plan's frozen container encode. */
  encode: { crf: number; preset: MiniToolPlanTarget["preset"] };
}
/** One person's dialogue stem (§7.17 lipsync_stem row): each row placed at its start and summed, `duration` long. */
export interface MiniToolPlanLipsyncStem { kind: "lipsync_stem"; rows: { inputId: string; startTime: MiniToolPlanExact }[]; duration: MiniToolPlanExact }
/** One chunk of the lip-sync composite on the result clock (§7.17 lipsync_composite row); `window` holds result-frame ordinals. */
export type MiniToolPlanLipsyncComposite = {
  kind: "lipsync_composite"; timeline: LipsyncTimeline; table: VideoPresentationTable;
  persons: { result: string; faces: string; track: string; cropSize: number }[];
  /** The prepared video's coded size and picture rectangle: every track and face table is in its pixels. */
  prepared: { width: number; height: number; displayRect: MiniToolPlanPixelRect | null };
  /** The plan's frozen raw disk budget, which a chunk's raw source window stays within when its source goes back. */
  rawDiskBytes: number;
  /** The plan's frozen face feather, as a fraction of each face's shorter side. */
  feather: number;
} & MiniToolPlanWindowRecipe;

/**
 * Every job input a recipe reads: its source, a stitch's chunks and clips, a window's clips, a composite's results, a lip-sync
 * step's faces, track, results and dialogue audio.
 * @param recipe - A validated recipe.
 * @returns The input ids it names.
 * @throws {never} Never.
 */
export function miniToolPlanRecipeInputs(recipe: MiniToolPlanRecipe): string[] {
  switch (recipe.kind) {
    case "stitch": return [...("clips" in recipe ? recipe.clips.map((clip) => clip.inputId) : [recipe.inputId, ...(recipe.audio !== null && "kind" in recipe.audio ? recipe.audio.inputs : [])]),
      ...recipe.chunks.map((chunk) => chunk.inputId)];
    case "transition_window": return recipe.clips.map((clip) => clip.inputId);
    case "model_composite": return [recipe.inputId, ...(recipe.mode === "erase" ? [recipe.result, recipe.rle] : recipe.backgrounds.map((background) => background.inputId))];
    case "rle_join": return recipe.inputs.map((input) => input.inputId);
    case "model_window_mask": return [];
    case "lipsync_faces": return [recipe.inputId, recipe.track];
    case "lipsync_clip": return [recipe.inputId, recipe.faces, recipe.track];
    case "lipsync_stem": return recipe.rows.map((row) => row.inputId);
    case "lipsync_composite": return [recipe.inputId, ...recipe.persons.flatMap((person) => [person.result, person.faces, person.track])];
    default: return [recipe.inputId];
  }
}
