// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
/**
 * One presentation entry of a window (§7.17): a source clip span, decoded from its keyframe at `decodeStart` and shown from
 * `clipStart` over its presentation interval at `rate`, the last frame held to `displayEnd`; or a derived-empty frame.
 */
export type MiniToolPlanEntry =
  | { kind: "source"; decodeStart: MiniToolPlanExact; clipStart: MiniToolPlanExact; displayStart: MiniToolPlanExact; displayEnd: MiniToolPlanExact; rate: MiniToolPlanExact }
  | { kind: "empty"; fill: "black" | "transparent"; window: MiniToolPlanInterval };
/** The carrier an encode writes (§91 D-2): even coded size, where the picture sits, the plan matrix and conversion. */
export interface MiniToolPlanTarget {
  width: number;
  height: number;
  displayRect: MiniToolPlanPixelRect | null;
  colorMatrix: string;
  toneMap: "none" | "sdr-bt709";
  alpha: "none" | "packed";
  crf: number;
  preset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
}
/** A presentation window's frames, on its own clock of `1/timescale` from 0. */
interface MiniToolPlanWindowRecipe {
  inputId: string;
  window: { start: number; end: number };
  timescale: number;
  entries: MiniToolPlanEntry[];
  target: MiniToolPlanTarget;
}

/** Media recipes shared with a container that loads no validation libraries. */
export type MiniToolPlanRecipe =
  | { kind: "inspect_video"; inputId: string }
  | { kind: "frame"; inputId: string; frameIndex: number; orientation?: "display"; crop?: MiniToolPlanFrameCrop }
  | { kind: "segment"; inputId: string; range: { start: number; end: number }; audioEnd?: number }
  | { kind: "people"; inputId: string; anchor: { frameIndex: number; pts: number }; profile: MiniToolPlanDetectorProfile; orientation?: "display" }
  | { kind: "scene_cuts"; inputId: string; range: { start: number; end: number }; profile: MiniToolPlanDetectorProfile }
  | { kind: "copy_carrier"; inputId: string; colorMatrix: string }
  | ({ kind: "chunk_encode" } & MiniToolPlanWindowRecipe)
  | { kind: "stitch"; inputId: string; chunks: { inputId: string; duration: MiniToolPlanExact }[]; audio: MiniToolPlanInterval | null; target: MiniToolPlanTarget }
  | ({ kind: "prepare_model_input"; audio: MiniToolPlanInterval | null } & MiniToolPlanWindowRecipe);
