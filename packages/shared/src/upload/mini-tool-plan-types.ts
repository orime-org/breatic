// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
/** A recipe's frame grid (§4.1, §7.17): the rate, the grid start in source seconds, the slots and the real video slots V. */
export interface MiniToolPlanGrid { fps: FrameRate; gridStart: MiniToolPlanExact; frameCount: number; realFrameCount: number }
/** A recipe's tool source (§7.16): the original with its keyframe statistics, or the edit-friendly file. */
export type MiniToolPlanToolSource = { kind: "original"; keyframes: SourceKeyframeStats } | { kind: "edit" };
/** A half-open range of grid frames [start, end). */
export interface MiniToolPlanFrames { start: number; end: number }
/** What an encode writes (§91 D-2), a presentation carrier or a split output: the coded size (even for H.264), where the picture sits, the plan matrix and conversion. */
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
  /** A split output's container and codec (§91 D4-4); a carrier has none. */
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
  | { kind: "scene_cuts"; inputId: string; grid: MiniToolPlanGrid; source: MiniToolPlanToolSource; frames: MiniToolPlanFrames; profile: MiniToolPlanDetectorProfile; target: MiniToolPlanAnalysisTarget }
  // The decode-only count (§4.1 frame count row, §7.17 grid_count): no object is written.
  | { kind: "grid_count"; inputId: string; gridStart: MiniToolPlanExact; fps: FrameRate; gridEnd: MiniToolPlanExact | null }
  // One chunk of the edit-friendly file (§4.2), tone mapped once for an HDR source.
  | MiniToolPlanEditEncode
  // One encode chunk of an output over its grid frames.
  | ({ kind: "chunk_encode" } & MiniToolPlanWindowRecipe)
  | MiniToolPlanStitch
  | MiniToolPlanEditStitch;

/** One edit-file chunk (§4.2, §7.17 edit_encode row): its tier and encode settings, the explicit colour inputs and the tone map. */
export interface MiniToolPlanEditEncode {
  kind: "edit_encode"; inputId: string; grid: MiniToolPlanGrid; source: MiniToolPlanToolSource; frames: MiniToolPlanFrames;
  edit: { profile: EditFileTier; crf: number; preset: MiniToolPlanTarget["preset"] }; color: MiniToolPlanColorInputs; toneMap: "none" | "sdr-bt709";
}
/** A chunk joined by stream copy: its object and the grid frames it holds, checked against them (§5.4 chunk timing row). */
export interface MiniToolPlanChunkRef { inputId: string; frames: MiniToolPlanFrames }
/** The edit file's chunks joined, no audio (§7.17 stitch row, edit_stitch stage). */
export interface MiniToolPlanEditStitch { kind: "stitch"; chunks: MiniToolPlanChunkRef[]; grid: MiniToolPlanGrid; edit: { profile: EditFileTier } }
/** Chunks joined by stream copy with the original's audio over the grid (§5.4). */
export interface MiniToolPlanStitch {
  kind: "stitch"; inputId: string; grid: MiniToolPlanGrid; chunks: MiniToolPlanChunkRef[]; audio: boolean; target: MiniToolPlanTarget;
}
/**
 * Every job input a recipe reads: its source and a stitch's chunks.
 * @param recipe - A validated recipe.
 * @returns The input ids it names.
 * @throws {never} Never.
 */
export function miniToolPlanRecipeInputs(recipe: MiniToolPlanRecipe): string[] {
  switch (recipe.kind) {
    case "stitch": return [...("edit" in recipe ? [] : [recipe.inputId]), ...recipe.chunks.map((chunk) => chunk.inputId)];
    case "segment": return [recipe.inputId, ...(recipe.audioInputId === undefined ? [] : [recipe.audioInputId])];
    default: return [recipe.inputId];
  }
}
