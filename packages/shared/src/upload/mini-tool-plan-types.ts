// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LipsyncTimeline } from "@shared/mini-tools/lipsync-timeline.js";
import type { EditFileTier } from "@shared/mini-tools/video-encode-plan.js";
import type { FrameRate } from "@shared/upload/frame-grid-rate.js";
import type { SourceKeyframeStats } from "@shared/upload/frame-grid.js";

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

/** An exact rational time in seconds or a rate, of safe integers (the frame-rate shape, frames-split §4.1). */
export type MiniToolPlanExact = FrameRate;
/** An interval of exact times in grid seconds. */
export interface MiniToolPlanInterval { start: MiniToolPlanExact; end: MiniToolPlanExact }
/** A recipe's frame grid (§4.1, §7.17): the rate, the grid start in source seconds, the slots and the real video slots V. */
export interface MiniToolPlanGrid { fps: FrameRate; gridStart: MiniToolPlanExact; frameCount: number; realFrameCount: number }
/** A recipe's tool source (§7.16): the original with its keyframe statistics, or the edit-friendly file. */
export type MiniToolPlanToolSource = { kind: "original"; keyframes: SourceKeyframeStats } | { kind: "edit" };
/** A half-open range of grid frames [start, end). */
export interface MiniToolPlanFrames { start: number; end: number }
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
/** A window of grid frames read from a tool source by §7.16, written to `target`. */
interface MiniToolPlanWindowRecipe {
  inputId: string;
  grid: MiniToolPlanGrid;
  source: MiniToolPlanToolSource;
  frames: MiniToolPlanFrames;
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

/** An analysis picture's target: display geometry and the plan's colour conversion. */
export interface MiniToolPlanAnalysisTarget { width: number; height: number; colorMatrix: string; toneMap: "none" | "sdr-bt709" }

/** The explicit colour inputs of an edit encode (§4.3 colour/HDR/bit depth row): the plan matrix and the probed facts. */
export interface MiniToolPlanColorInputs { matrix: string; transfer: string | null; primaries: string | null; range: "tv" | "pc"; chromaLocation: string }
/** The grid one recipe reads a still from: a grid frame of the tool source. */
interface MiniToolPlanStillRecipe { inputId: string; grid: MiniToolPlanGrid; source: MiniToolPlanToolSource; frameIndex: number }
/**
 * Audio of a single-source output (§4.4): true reads the original's audio aligned to the grid start over the frames;
 * `audioInputId` names the original when the video comes from the edit file.
 */
interface MiniToolPlanAudioRef { audio: boolean; audioInputId?: string }

/** Media recipes shared with a container that loads no validation libraries; every time is grid time (§7.17). */
export type MiniToolPlanRecipe =
  // One grid frame (§7.17 frame row), optionally cropped in its display geometry (the video focus crop, §5.5).
  | ({ kind: "frame"; target: MiniToolPlanFrameTarget; crop?: MiniToolPlanFrameCrop } & MiniToolPlanStillRecipe)
  // The split segment over grid frames (§7.17 segment row).
  | ({ kind: "segment" } & MiniToolPlanWindowRecipe & MiniToolPlanAudioRef)
  | ({ kind: "people"; target: MiniToolPlanFrameTarget; profile: MiniToolPlanDetectorProfile } & MiniToolPlanStillRecipe)
  | { kind: "scene_cuts"; inputId: string; grid: MiniToolPlanGrid; source: MiniToolPlanToolSource; frames: MiniToolPlanFrames; profile: MiniToolPlanDetectorProfile; target: MiniToolPlanAnalysisTarget }
  // The decode-only count (§4.1 frame count row, §7.17 grid_count): no object is written.
  | { kind: "grid_count"; inputId: string; gridStart: MiniToolPlanExact; fps: FrameRate; gridEnd: MiniToolPlanExact | null }
  // One chunk of the edit-friendly file (§4.2), tone mapped once for an HDR source.
  | MiniToolPlanEditEncode
  // A transition chunk carries the profile and where the clip sits on the output grid, both or neither.
  | ({ kind: "chunk_encode"; profile?: MiniToolPlanTransitionProfile; placement?: MiniToolPlanClipPlacement } & MiniToolPlanWindowRecipe)
  | MiniToolPlanStitch
  | MiniToolPlanEditStitch
  | MiniToolPlanTransitionStitch
  // `order` plays the window backwards for a reversed tracking clip; `model` times the frames for the erase model (§10.2, §10.4).
  | ({ kind: "prepare_model_input"; order?: "forward" | "reverse"; model?: MiniToolPlanModelGrid } & MiniToolPlanWindowRecipe & MiniToolPlanAudioRef)
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

/** One edit-file chunk (§4.2, §7.17 edit_encode row): its tier and encode settings, the explicit colour inputs and the tone map. */
export interface MiniToolPlanEditEncode {
  kind: "edit_encode"; inputId: string; grid: MiniToolPlanGrid; source: MiniToolPlanToolSource; frames: MiniToolPlanFrames;
  edit: { profile: EditFileTier; crf: number; preset: MiniToolPlanTarget["preset"] }; color: MiniToolPlanColorInputs; toneMap: "none" | "sdr-bt709";
}
/** A chunk joined by stream copy: its object and the grid frames it holds, checked against them (§5.4 chunk timing row). */
export interface MiniToolPlanChunkRef { inputId: string; frames: MiniToolPlanFrames }
/** The edit file's chunks joined, no audio (§7.17 stitch row, edit_stitch stage). */
export interface MiniToolPlanEditStitch { kind: "stitch"; chunks: MiniToolPlanChunkRef[]; grid: MiniToolPlanGrid; edit: { profile: EditFileTier } }
/** Where a transition clip sits on the output grid: its first output frame and its trimmed in-frame there (§97 D15-3). */
export interface MiniToolPlanClipPlacement { startFrame: number; inFrame: number }

/** Every person's stem summed sample by sample over the result, from its start (§7.17 stitch row for lip-sync, §97 D22-3). */
export interface MiniToolPlanStemMix { kind: "mix"; inputs: string[] }
/** Chunks joined by stream copy with the original's audio over the grid or the lip-sync stems' sum encoded once (§5.4). */
export interface MiniToolPlanStitch {
  kind: "stitch"; inputId: string; grid: MiniToolPlanGrid; chunks: MiniToolPlanChunkRef[]; audio: boolean | MiniToolPlanStemMix; target: MiniToolPlanTarget;
}
/** The one output profile both clips of a transition are encoded to (frames-split §7.17, §97 D15-5). */
export interface MiniToolPlanTransitionProfile {
  width: number; height: number; fps: MiniToolPlanExact; timeBase: MiniToolPlanExact; pixFmt: "yuv420p" | "yuva420p";
  color: { matrix: "bt709"; range: "tv"; primaries: "bt709"; transfer: "bt709" }; codec: "h264" | "vp9";
  encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; alpha: boolean;
}
/** One clip of a transition stitch: its original, grid, placement and trimmed output frames, and whether it has audio. */
export interface MiniToolPlanStitchClip { inputId: string; grid: MiniToolPlanGrid; placement: MiniToolPlanClipPlacement; frameCount: number; audio: boolean }
/** A transition's chunks joined in timeline order, each clip's audio placed over its span and crossfaded over the window (§97 D15-7). */
export interface MiniToolPlanTransitionStitch {
  kind: "stitch"; chunks: MiniToolPlanChunkRef[];
  /** Each clip's original, grid and placement; `audio` false for a clip without audio (silence over its span). */
  clips: [MiniToolPlanStitchClip, MiniToolPlanStitchClip];
  /** The overlap window the two audio tracks cross over, null for a Cut. */
  crossfade: { startFrame: number; frameCount: number } | null;
  profile: MiniToolPlanTransitionProfile;
}
/**
 * One clip of a transition window: its tool source and grid, where it sits on the output grid, the matrix and tone mapping
 * of its own plan (§97 D23-4), and where it sits on the output frame (`transitionFitRect`).
 */
export interface MiniToolPlanWindowClip {
  inputId: string; grid: MiniToolPlanGrid; source: MiniToolPlanToolSource; placement: MiniToolPlanClipPlacement;
  colorMatrix: string; toneMap: "none" | "sdr-bt709"; fit: MiniToolPlanPixelRect;
}
/** One chunk `frames` of a transition's overlap window, composed from both clips' grid frames (§97 D15-6). */
export interface MiniToolPlanTransitionWindow {
  kind: "transition_window";
  /** Each clip's grid frames and its own plan's conversion, applied before the blend. */
  clips: [MiniToolPlanWindowClip, MiniToolPlanWindowClip];
  frames: { start: number; end: number };
  window: { startFrame: number; frameCount: number };
  transition: "fade" | "wipeLeft" | "wipeRight";
  profile: MiniToolPlanTransitionProfile;
}
/** The erase model's frame grid (execution design §10.4): frame for frame at `rate`, or resampled on a `rate` grid. */
export interface MiniToolPlanModelGrid { mode: "frames" | "resample"; rate: number; frameCount: number }
/** A range of grid frames by its first frame and count. */
export interface MiniToolPlanFrameRange { startFrame: number; frameCount: number }
/**
 * An erase composite chunk (execution design §10.4 composite row): each range frame shows its grid slot's result frame through
 * the RLE mask, dilated and feathered in source pixels; the chunk's frames lie in the range on the grid.
 */
export type MiniToolPlanEraseComposite = {
  kind: "model_composite"; mode: "erase"; result: string; rle: string; range: MiniToolPlanFrameRange;
  model: MiniToolPlanModelGrid; matte: { dilate: number; feather: number };
  /** The RLE's frame size: the tracking clips' coded size, which can differ from this chunk's target by the even rounding. */
  rleSize: { width: number; height: number };
} & MiniToolPlanWindowRecipe;
/** The forward and reversed tracking clips' RLE joined over the range (execution design §10.2). */
export interface MiniToolPlanRleJoin { kind: "rle_join"; inputs: { inputId: string; order: "forward" | "reverse"; frameCount: number }[]; width: number; height: number }
/** The erase model's mask video: one lossless full-range frame per grid slot, white where its RLE frame has foreground (§10.4). */
export interface MiniToolPlanBriaMask {
  kind: "bria_mask"; inputId: string; fps: FrameRate; range: MiniToolPlanFrameRange; model: MiniToolPlanModelGrid; target: { width: number; height: number };
}
/** The expand model's frame grid for one window: `frameCount` frames at `fps` from the span's start (§10.5). */
export interface MiniToolPlanWindowGrid { fps: number; frameCount: number }
/** One expand window's model input (§10.5): each model slot's covering grid frame scaled into `sourceRoi` over `fill`, lossless. */
export type MiniToolPlanModelWindow = {
  kind: "model_window"; model: MiniToolPlanWindowGrid; frame: { width: number; height: number }; sourceRoi: MiniToolPlanPixelRect;
  fill: [number, number, number]; span: MiniToolPlanInterval;
} & MiniToolPlanWindowRecipe;
/** One expand window's mask: black inside `sourceRoi`, white elsewhere, lossless full range (§10.5). */
export interface MiniToolPlanModelWindowMask { kind: "model_window_mask"; model: MiniToolPlanWindowGrid; frame: { width: number; height: number }; sourceRoi: MiniToolPlanPixelRect; span: MiniToolPlanInterval }
/** The PNG of one grid frame of a video (§10.5 condition step). */
export type MiniToolPlanFrameAt = { kind: "frame_at"; target: { width: number; height: number } } & MiniToolPlanStillRecipe;
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
  kind: "lipsync_clip"; inputId: string; faces: string; track: string; cropSize: number; timeline: LipsyncTimeline; grid: MiniToolPlanGrid;
  /** The plan's frozen container encode. */
  encode: { crf: number; preset: MiniToolPlanTarget["preset"] };
}
/** One person's dialogue stem (§7.17 lipsync_stem row): each row placed at its start and summed, `duration` long. */
export interface MiniToolPlanLipsyncStem { kind: "lipsync_stem"; rows: { inputId: string; startTime: MiniToolPlanExact }[]; duration: MiniToolPlanExact }
/** One chunk of the lip-sync composite on the result clock (§7.17 lipsync_composite row); `frames` holds result frames. */
export type MiniToolPlanLipsyncComposite = {
  kind: "lipsync_composite"; timeline: LipsyncTimeline;
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
    case "stitch": return [...("clips" in recipe ? recipe.clips.map((clip) => clip.inputId)
      : "edit" in recipe ? [] : [recipe.inputId, ...(typeof recipe.audio === "object" ? recipe.audio.inputs : [])]), ...recipe.chunks.map((chunk) => chunk.inputId)];
    case "segment": case "prepare_model_input": return [recipe.inputId, ...(recipe.audioInputId === undefined ? [] : [recipe.audioInputId])];
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
