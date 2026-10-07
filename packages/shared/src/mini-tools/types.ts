// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The shape of one mini-tool declaration (inner#888 §5).
 *
 * A tool states where it runs, what it reads, what it writes and which
 * controls its panel draws. A model tool lists only the yaml param names it
 * exposes; their options, defaults and ranges are read from the pinned
 * model's catalog entry, so none of them is written here a second time.
 */

/** A modality a tool acts on or produces. */
export type MiniToolMedium = "image" | "video" | "audio";

/** The ffmpeg operations the mini-tool container runs. */
export const CONTAINER_OPS = ["crop", "speed", "cut", "adjust", "audio_denoise", "stabilize", "hdr"] as const;

/** One of {@link CONTAINER_OPS}. */
export type ContainerOp = (typeof CONTAINER_OPS)[number];

/**
 * Why a container job failed. `no_audio_track` is an operation on the sound
 * given a source without one; everything else the tool or the run broke on is
 * `tool_failed`.
 */
export const CONTAINER_FAILURES = ["tool_failed", "no_audio_track"] as const;

/** One of {@link CONTAINER_FAILURES}. */
export type ContainerFailure = (typeof CONTAINER_FAILURES)[number];

/** Where a tool runs. */
export type MiniToolRun =
  | { readonly kind: "browser" }
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "container"; readonly op: ContainerOp };

/** The lucide icon a tool's menu row shows. */
export type MiniToolIcon =
  | "Eraser"
  | "Maximize2"
  | "UserRound"
  | "Crop"
  | "RotateCw"
  | "GalleryVerticalEnd"
  | "StretchHorizontal"
  | "Wand2"
  | "PersonStanding"
  | "Clapperboard"
  | "Gauge"
  | "Scissors"
  | "SlidersHorizontal"
  | "AudioLines"
  | "Crosshair"
  | "Sun"
  | "SplitSquareVertical"
  | "Timer";

/**
 * One choice of an enum param. It reads as its `label` when it has one — the
 * same word in every language, as the focus crop's presets are — and as its
 * value otherwise.
 */
export interface MiniToolOption {
  readonly value: string;
  readonly label?: string;
}

/** A slider. */
export interface NumberParam {
  readonly kind: "number";
  readonly key: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string;
}

/** A row of choices. */
export interface EnumParam {
  readonly kind: "enum";
  readonly key: string;
  readonly default: string;
  readonly options: readonly MiniToolOption[];
}

/** A crop rectangle in source pixels; null until the panel reads the source size. */
export interface RectParam {
  readonly kind: "rect";
  readonly key: string;
  /** The enum param that locks the rectangle's aspect. */
  readonly aspect?: string;
}

/** A time range in seconds; null until the panel reads the source length. */
export interface RangeParam {
  readonly kind: "range";
  readonly key: string;
}

/** A set of colour sliders, each in the shared `AdjustValue` scale. */
export interface AdjustParam {
  readonly kind: "adjust";
  readonly key: string;
}

/** Quarter turns and flips. */
export interface OrientParam {
  readonly kind: "orient";
  readonly key: string;
}

/** A param a browser or container tool declares in full. */
export type MiniToolParam = NumberParam | EnumParam | RectParam | RangeParam | AdjustParam | OrientParam;

/** A model tool's exposed param: the yaml name, everything else read from the catalog. */
export interface MiniToolModelParam {
  readonly key: string;
}

/** A second piece of media the tool reads, picked from the canvas. */
export interface MiniToolSlot {
  readonly key: string;
  /** The pinned model's yaml param it fills. */
  readonly param: string;
  readonly accepts: MiniToolMedium;
  /** Whether the param is a list; its cap is the yaml param's `max_items`. */
  readonly many: boolean;
  /** The pick banner's text. */
  readonly bannerKey: string;
}

/** One result node the tool produces. */
export interface MiniToolOutput {
  readonly modality: MiniToolMedium | "text";
  /** Upper-case prefix of the new node's name, as in `CROP-IMAGE-1`. */
  readonly namePrefix: string;
}

/** Fields every tool declares. */
interface MiniToolBase {
  /** `<source>.<name>`, unique across the registry. */
  readonly id: string;
  readonly source: MiniToolMedium;
  readonly labelKey: string;
  readonly icon: MiniToolIcon;
  readonly slots: readonly MiniToolSlot[];
  readonly outputs: readonly MiniToolOutput[];
  /** The param the source media fills: the model's yaml name, or the container op's input. */
  readonly sourceParam: string;
  /** Present on a model tool whose pinned model takes a prompt. */
  readonly prompt?: { readonly placeholderKey: string };
}

/** A tool run on a pinned catalog model. */
export interface ModelToolSpec extends MiniToolBase {
  readonly run: { readonly kind: "model"; readonly model: string };
  readonly params: readonly MiniToolModelParam[];
}

/** A tool run in the browser or in the container. */
export interface LocalToolSpec extends MiniToolBase {
  readonly run: { readonly kind: "browser" } | { readonly kind: "container"; readonly op: ContainerOp };
  readonly params: readonly MiniToolParam[];
}

/** One mini-tool declaration. */
export type MiniToolSpec = ModelToolSpec | LocalToolSpec;
