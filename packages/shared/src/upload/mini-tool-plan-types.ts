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
/** One edit of the audio track: media [sourceStart, sourceEnd) shown from presentationStart at rate. */
export interface MiniToolPlanEditSpan { sourceStart: MiniToolPlanExact; sourceEnd: MiniToolPlanExact; presentationStart: MiniToolPlanExact; rate: MiniToolPlanExact }
/**
 * The audio a recipe carries (§91 D3b-11): its presentation interval, the plan's origin and audio spans; with spans the
 * media samples are placed by them, without (no audio edit) presentation time is movie time less the origin.
 */
export interface MiniToolPlanAudio extends MiniToolPlanInterval { origin: MiniToolPlanExact; spans: MiniToolPlanEditSpan[] | null }
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
  | ({ kind: "chunk_encode" } & MiniToolPlanWindowRecipe)
  | { kind: "stitch"; inputId: string; chunks: { inputId: string; duration: MiniToolPlanExact }[]; audio: MiniToolPlanAudio | null; target: MiniToolPlanTarget }
  | ({ kind: "prepare_model_input"; audio: MiniToolPlanAudio | null } & MiniToolPlanWindowRecipe);
