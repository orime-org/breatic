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
 * given a source without one; `internal` is the run losing the source download
 * or the output upload; everything else the tool broke on is `tool_failed`.
 */
export const CONTAINER_FAILURES = ["tool_failed", "no_audio_track", "internal"] as const;

/** One of {@link CONTAINER_FAILURES}. */
export type ContainerFailure = (typeof CONTAINER_FAILURES)[number];

/** Where a tool runs. */
export type MiniToolRun =
  | { readonly kind: "browser" }
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "container"; readonly op: ContainerOp };

/** The lucide icon a tool's menu row shows. */
export type MiniToolIcon =
  | "Brush"
  | "ImageMinus"
  | "PencilLine"
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
  | "Timer"
  | "Highlighter"
  | "Expand"
  | "Grid3x3"
  | "Rotate3d"
  | "Lightbulb"
  | "Palette"
  | "SquarePen";

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

/** A list of numbers the reader enters, such as cut points; capped at `maxItems`. */
export interface ListParam {
  readonly kind: "list";
  readonly key: string;
  readonly item: { readonly min: number; readonly max: number; readonly step: number };
  readonly maxItems: number;
}

/**
 * Cells of a grid the reader leaves out, by row-major index from 0; empty means
 * every cell. Named by a product count's `except`.
 */
export interface CellsParam {
  readonly kind: "cells";
  readonly key: string;
}

/** A param a browser or container tool declares in full. */
export type MiniToolParam =
  | NumberParam
  | EnumParam
  | RectParam
  | RangeParam
  | AdjustParam
  | OrientParam
  | ListParam
  | CellsParam;

/** One output size a megapixel param offers: the source's long edge scaled to `longEdge`. */
export interface SizeTier {
  /** The tier's name, the same word in every language. */
  readonly label: string;
  readonly longEdge: number;
}

/** A model tool's exposed param: the yaml name, everything else read from the catalog. */
export interface MiniToolModelParam {
  readonly key: string;
  /**
   * Present on a megapixel param chosen as an output size: the draft holds a
   * tier's label, and the run is sent the megapixels it comes to on the source.
   */
  readonly sizeTiers?: readonly SizeTier[];
  /**
   * The tool's own starting value, over the catalog's default, which the
   * generation panel keeps for the same model. One of the catalog's values.
   */
  readonly default?: string | number;
  /**
   * How the panel draws the param, when not by its declaration: `swatches` a
   * row of colours; `swatchCustom` the colour picked by hand, drawn as the
   * last cell of that row; `lightAngle` the light sphere, which takes the two
   * params so marked, the azimuth first.
   */
  readonly display?: "swatches" | "swatchCustom" | "lightAngle";
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
  /** Present when the tool needs the slot filled, though its param is optional in the catalog. */
  readonly required?: true;
}

/** One result node the tool produces. */
export interface MiniToolOutput {
  readonly modality: MiniToolMedium | "text";
  /** Upper-case prefix of the new node's name, as in `CROP-IMAGE-1`. */
  readonly namePrefix: string;
}

/**
 * A layer the reader draws on the source; the run is sent an image made from
 * it, at the source's pixels as the browser shows them. A mask tool sends,
 * under `maskParam`, a black-and-white image of the same size, white where to
 * change, beside the source itself (stored upright since inner#1367); a sketch
 * tool sends the source with the drawing painted on it in place of the source.
 */
export type MiniToolDrawing =
  | { readonly kind: "mask"; readonly maskParam: string }
  | { readonly kind: "sketch" };

/** Fields every tool declares. */
interface MiniToolBase {
  /** `<source>.<name>`, unique across the registry. */
  readonly id: string;
  readonly source: MiniToolMedium;
  readonly labelKey: string;
  /**
   * What the tool is for, in one English clause the product guide sets after
   * its name, so the agent can match a reader's need to the tool.
   */
  readonly guide: string;
  readonly icon: MiniToolIcon;
  readonly slots: readonly MiniToolSlot[];
  /** The param the source media fills: the model's yaml name, or the container op's input. */
  readonly sourceParam: string;
  /** Whether that param is a list, as a slot's `many` says of its param. */
  readonly sourceMany: boolean;
  /** Present on a tool the reader draws on the node for. */
  readonly drawing?: MiniToolDrawing;
  /**
   * Present on a tool the reader marks the picture up with — shapes, arrows,
   * lines, pen strokes and text that stay selectable until the run — for
   * people to read rather than for a model.
   */
  readonly markup?: true;
  /**
   * Present on a tool that grows the picture past its edges: the run sends,
   * in place of the source, the picture padded onto the larger canvas under
   * `imageParam` and a mask of the same size, white where the canvas is new,
   * under `maskParam`.
   */
  readonly expand?: { readonly imageParam: string; readonly maskParam: string };
  /**
   * Present on a model tool whose pinned model takes a prompt. `defaultText`,
   * when given, is sent in place of an empty prompt, so the reader may leave
   * it empty. `preamble`, when given, is always sent, with what the reader
   * wrote after it.
   */
  readonly prompt?: { readonly placeholderKey: string; readonly defaultText?: string; readonly preamble?: string };
  /**
   * A catalog param the server fills with the aspect ratio nearest the
   * source's size, read off the request; the reader never sets it.
   */
  readonly sourceAspectParam?: string;
  /**
   * How the panel lays the tool out, when not as one column: `columns.left`
   * names the params drawn in a left column, the rest going on the right;
   * `whenSlotFilled` hides params while a slot holds a pick, which then shows
   * large in the left column. Hidden params are not sent.
   */
  readonly panel?: {
    readonly columns?: { readonly left: readonly string[] };
    readonly whenSlotFilled?: { readonly slot: string; readonly hide: readonly string[] };
  };
}

/**
 * How many results a variable tool makes, read off its params before the run:
 * the product of number params (a grid's rows and columns), less the cells a
 * cells param named by `except` leaves out; or a list param's length plus
 * `plus` (cut points into segments).
 */
export type MiniToolOutputCount =
  | { readonly kind: "product"; readonly params: readonly string[]; readonly except?: string }
  | { readonly kind: "listLength"; readonly param: string; readonly plus: number };

/** A tool whose results are a fixed list. */
interface FixedOutputs {
  readonly outputs: readonly MiniToolOutput[];
  readonly output?: never;
  readonly outputCount?: never;
  readonly outputLayout?: never;
  readonly groupOutputs?: never;
}

/** A tool whose results are one template repeated as many times as its params say. */
interface VariableOutputs {
  readonly output: MiniToolOutput;
  readonly outputCount: MiniToolOutputCount;
  /**
   * How the results sit on the canvas: one column when absent, or rows by
   * columns for `"grid"`, whose count is the product of two params (rows first).
   */
  readonly outputLayout?: "grid";
  /** Whether the results go into a new group of their own. */
  readonly groupOutputs?: boolean;
  readonly outputs?: never;
}

/**
 * A tool run on a pinned catalog model. The registry does not declare its
 * params (the server checks them against the model's catalog entry at run
 * time), so nothing can count results from them and its outputs are fixed.
 */
export interface ModelToolSpec extends MiniToolBase, FixedOutputs {
  readonly run: { readonly kind: "model"; readonly model: string };
  readonly params: readonly MiniToolModelParam[];
}

/** The run and params of a tool run in the browser or in the container. */
interface LocalToolBase extends MiniToolBase {
  readonly run: { readonly kind: "browser" } | { readonly kind: "container"; readonly op: ContainerOp };
  readonly params: readonly MiniToolParam[];
}

/** A tool run in the browser or in the container. */
export type LocalToolSpec = LocalToolBase & (FixedOutputs | VariableOutputs);

/** One mini-tool declaration. */
export type MiniToolSpec = ModelToolSpec | LocalToolSpec;
