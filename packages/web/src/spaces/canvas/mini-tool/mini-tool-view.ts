// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a mini-tool panel shows and whether it may run (inner#888 §7), as pure
 * functions over the registry, the pinned model's catalog entry and the draft.
 */

import {
  isAdjustValueNeutral,
  parseAdjustValue,
  type ModelEntry,
} from '@breatic/shared';
import { isExpanded, sourceTooLargeToExpand, type ExpandFrame } from '@web/spaces/canvas/mini-tool/expand-frame';
import { keepsSourceSize } from '@web/spaces/canvas/mini-tool/output-placement';
import { markEmpty, type MarkDraft } from '@web/stores/mark-draft';
import {
  defaultSizeTier,
  gridShapeOf,
  isModelTool,
  pickedCellsOf,
  sizeTierOptions,
  tieredParamKeys,
  type MiniToolSlot,
  type MiniToolSlotValue,
  type MiniToolSpec,
  type SizeTierOption,
} from '@breatic/shared/mini-tools';

/** A crop rectangle in source pixels. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A source's pixel size. */
export interface SourceSize {
  width: number;
  height: number;
}

/** What the source node is showing, as far as the panel needs it. */
export interface MiniToolSourceInfo {
  width?: number | undefined;
  height?: number | undefined;
  /** Seconds. */
  duration?: number | undefined;
  /** Where the source plays from. */
  url?: string | undefined;
}

/** A param chosen as an output size: its tiers on the source and the one in use. */
export interface SizeTierChoice {
  key: string;
  options: readonly SizeTierOption[];
  /** The tier the run takes; undefined when no tier is usable for the source. */
  selected: string | undefined;
}

/** Why Execute is held back, or null when it may run. */
export type MiniToolRefusal =
  | 'sourceMissing'
  | 'noUsableTier'
  | 'slotMissing'
  | 'slotTooLong'
  | 'drawingEmpty'
  | 'adjustNeutral'
  | 'singleTile'
  | 'noTilePicked'
  | 'sourceTooLargeToExpand'
  | 'frameNotExpanded'
  | 'markEmpty'
  | 'promptMissing'
  | 'exporting'
  | null;

/** The refusals that disable Execute; the rest let it be pressed and say why. */
export const BLOCKING_REFUSALS: ReadonlySet<MiniToolRefusal> = new Set<MiniToolRefusal>([
  'slotMissing',
  'drawingEmpty',
  'adjustNeutral',
  'singleTile',
  'noTilePicked',
  'frameNotExpanded',
  'markEmpty',
  'promptMissing',
  'exporting',
]);

/** How the panel's footer states the cost. */
export type CreditMode = 'free' | 'usage' | 'estimate';

/**
 * The size tiers a model tool offers, as they fall on the source. The draft
 * holds the picked tier's label; a tier the source has outgrown is not kept.
 * @param spec - The tool.
 * @param entry - The pinned model's catalog entry.
 * @param draft - The panel's draft params.
 * @param source - The source as the panel knows it.
 * @returns One choice per tiered param; none while the source size is unknown.
 */
export function sizeTierChoices(
  spec: MiniToolSpec,
  entry: ModelEntry | undefined,
  draft: Readonly<Record<string, unknown>>,
  source: MiniToolSourceInfo,
): SizeTierChoice[] {
  if (!isModelTool(spec) || source.width === undefined || source.height === undefined) return [];
  const size = { width: source.width, height: source.height };
  return spec.params.flatMap((param) => {
    if (param.sizeTiers === undefined) return [];
    const options = sizeTierOptions(param.sizeTiers, size, entry?.params[param.key]);
    const picked = draft[param.key];
    const usable = options.some((option) => option.usable && option.label === picked);
    return [{ key: param.key, options, selected: usable ? (picked as string) : defaultSizeTier(options) }];
  });
}

/**
 * The params a run is sent: a model tool's listed params on the pinned model's
 * defaults with the draft on top, a size tier sent as the megapixels it comes
 * to on the source; a local tool's draft, with a range nobody dragged sent as
 * the whole clip the panel shows it as.
 * @param spec - The tool.
 * @param entry - The pinned model's catalog entry, for a model tool.
 * @param draft - The panel's draft params.
 * @param source - The source as the panel knows it.
 * @param tiers - The size tiers as they fall on the source.
 * @param slots - The draft slots; a param the panel hides while a slot is filled is not sent.
 * @returns The params by key.
 */
export function resolvedParams(
  spec: MiniToolSpec,
  entry: ModelEntry | undefined,
  draft: Readonly<Record<string, unknown>>,
  source: MiniToolSourceInfo = {},
  tiers: readonly SizeTierChoice[] = sizeTierChoices(spec, entry, draft, source),
  slots: MiniToolSlots = {},
): Record<string, unknown> {
  if (!isModelTool(spec)) {
    const out: Record<string, unknown> = { ...draft };
    for (const param of spec.params) {
      if (param.kind === 'range' && out[param.key] == null && source.duration !== undefined) {
        out[param.key] = { start: 0, end: source.duration };
      }
    }
    return out;
  }
  const tierOf = new Map(tiers.map((choice) => [choice.key, choice]));
  const hidden = new Set(hiddenParams(spec, slots));
  const out: Record<string, unknown> = {};
  for (const param of spec.params) {
    if (hidden.has(param.key)) continue;
    if (param.sizeTiers !== undefined) {
      const choice = tierOf.get(param.key);
      const tier = choice?.options.find((option) => option.label === choice.selected);
      if (tier !== undefined) out[param.key] = tier.megapixels;
      continue;
    }
    const value = param.key in draft ? draft[param.key] : (param.default ?? entry?.params[param.key]?.default);
    if (value !== undefined && value !== null) out[param.key] = value;
  }
  return out;
}

/** The draft slots, by slot key. */
type MiniToolSlots = Readonly<Record<string, MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined>>;

/**
 * Whether a slot holds anything.
 * @param held - What the draft holds for it.
 * @returns True when it holds a pick.
 */
export function slotFilled(held: MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined): boolean {
  return held !== undefined && !(Array.isArray(held) && held.length === 0);
}

/**
 * The params the panel hides, and the run does not send, while the slot the
 * tool names holds a pick.
 * @param spec - The tool.
 * @param slots - The draft slots.
 * @returns The hidden param keys.
 */
export function hiddenParams(spec: MiniToolSpec, slots: MiniToolSlots): readonly string[] {
  const rule = spec.panel?.whenSlotFilled;
  return rule !== undefined && slotFilled(slots[rule.slot]) ? rule.hide : [];
}

/**
 * Whether a slot may stay empty: the tool does not require it and its yaml
 * param says `optional`.
 * @param slot - The slot.
 * @param entry - The pinned model's catalog entry.
 * @returns True when the run goes without it.
 */
export function slotOptional(slot: MiniToolSlot, entry: ModelEntry | undefined): boolean {
  return slot.required !== true && entry?.params[slot.param]?.optional === true;
}

/**
 * Whether the run must carry a prompt: the tool draws a prompt box and its
 * pinned model takes one.
 * @param spec - The tool.
 * @param entry - The pinned model's catalog entry.
 * @returns True when an empty prompt holds Execute back.
 */
export function promptRequired(spec: MiniToolSpec, entry: ModelEntry | undefined): boolean {
  return spec.prompt !== undefined && spec.prompt.defaultText === undefined && entry?.takes_prompt === true;
}

/**
 * The total length a `many` slot is over, when its picks add up past the
 * pinned model's `max_total_duration`. Picks whose length is unknown are not
 * counted; the model answers for them.
 * @param spec - The tool.
 * @param entry - The pinned model's catalog entry.
 * @param slots - The draft slots.
 * @returns The cap in seconds that is exceeded, or null.
 */
export function slotLengthCap(
  spec: MiniToolSpec,
  entry: ModelEntry | undefined,
  slots: MiniToolSlots,
): number | null {
  for (const slot of spec.slots) {
    const cap = entry?.params[slot.param]?.max_total_duration;
    const held = slots[slot.key];
    if (cap === undefined || !Array.isArray(held)) continue;
    const total = (held as readonly MiniToolSlotValue[]).reduce((sum, pick) => sum + (pick.duration ?? 0), 0);
    if (total > cap) return cap;
  }
  return null;
}

/**
 * Whether a tool lays its result out in the source's pixels: the expand's
 * frame and the grid's tiles. Its size arrives with the source's metadata, or
 * from the shown picture when the node records none.
 * @param spec - The tool.
 * @returns True when the result needs the source's pixel size.
 */
export function laysOutInSourcePixels(spec: MiniToolSpec): boolean {
  return spec.expand !== undefined || spec.outputLayout === 'grid';
}

/**
 * Whether the panel reads the size of the picture the node shows when the
 * node's data does not carry it: the tool measures something on the source,
 * or the server takes its ratio from the size the request says.
 * @param spec - The tool.
 * @returns True when the shown size is read.
 */
export function readsShownSize(spec: MiniToolSpec): boolean {
  return (
    tieredParamKeys(spec).length > 0 ||
    spec.drawing !== undefined ||
    laysOutInSourcePixels(spec) ||
    keepsSourceSize(spec) ||
    spec.sourceAspectParam !== undefined
  );
}

/**
 * Why Execute is held back right now.
 * @param input - What the panel knows.
 * @param input.spec - The tool.
 * @param input.entry - The pinned model's catalog entry, for a model tool.
 * @param input.prompt - The draft prompt.
 * @param input.slots - The draft slots.
 * @param input.sourceShown - Whether the source node is showing its media.
 * @param input.source - The source as the panel knows it.
 * @param input.tiers - The size tiers as they fall on the source.
 * @param input.exporting - Whether a press of this tool is still under way: making its file or
 *   images in the browser, or waiting for the server's answer.
 * @param input.inked - Whether a drawing tool's drawing leaves any ink.
 * @param input.params - The draft params.
 * @param input.expandFrame - An expand tool's frame.
 * @param input.mark - A markup tool's draft.
 * @returns The first reason in the order the reader would fix them, or null.
 */
export function miniToolRefusal(input: {
  spec: MiniToolSpec;
  entry: ModelEntry | undefined;
  prompt: string;
  slots: MiniToolSlots;
  sourceShown: boolean;
  source?: MiniToolSourceInfo;
  tiers?: readonly SizeTierChoice[];
  exporting: boolean;
  inked?: boolean;
  params?: Readonly<Record<string, unknown>>;
  expandFrame?: ExpandFrame;
  mark?: MarkDraft | null;
}): MiniToolRefusal {
  const { spec, entry, prompt, slots, sourceShown, source = {}, exporting, params = {} } = input;
  if (exporting) return 'exporting';
  if (!sourceShown) return 'sourceMissing';
  // A range is measured on the source's length, which arrives with its metadata.
  const measuresLength = !isModelTool(spec) && spec.params.some((param) => param.kind === 'range');
  if (measuresLength && source.duration === undefined) return 'sourceMissing';
  // A size tier is measured on the source's pixel size, which arrives the same way.
  if (tieredParamKeys(spec).length > 0) {
    const choices = input.tiers ?? sizeTierChoices(spec, entry, {}, source);
    if (choices.length === 0) return 'sourceMissing';
    if (choices.some((choice) => choice.selected === undefined)) return 'noUsableTier';
  }
  for (const slot of spec.slots) {
    if (!slotFilled(slots[slot.key]) && !slotOptional(slot, entry)) return 'slotMissing';
  }
  if (slotLengthCap(spec, entry, slots) !== null) return 'slotTooLong';
  if (spec.drawing !== undefined && input.inked !== true) return 'drawingEmpty';
  if (laysOutInSourcePixels(spec) && (source.width === undefined || source.height === undefined)) return 'sourceMissing';
  if (spec.expand !== undefined && source.width !== undefined && source.height !== undefined) {
    const cap = expandCapOf(entry);
    if (sourceTooLargeToExpand({ width: source.width, height: source.height }, cap)) return 'sourceTooLargeToExpand';
    if (input.expandFrame === undefined || !isExpanded(input.expandFrame, { width: source.width, height: source.height })) {
      return 'frameNotExpanded';
    }
  }
  if (spec.markup === true && (input.mark == null || markEmpty(input.mark))) return 'markEmpty';
  // Every slider at zero changes nothing.
  const adjust = isModelTool(spec) ? undefined : spec.params.find((param) => param.kind === 'adjust');
  if (adjust !== undefined && isAdjustValueNeutral(parseAdjustValue(params[adjust.key]))) return 'adjustNeutral';
  // A grid of one cell leaves nothing cut; a grid with no cell picked makes nothing.
  const shape = gridShapeOf(spec, params);
  if (shape !== null && shape.rows * shape.cols <= 1) return 'singleTile';
  if (pickedCellsOf(spec, params)?.length === 0) return 'noTilePicked';
  if (promptRequired(spec, entry) && prompt.trim() === '') return 'promptMissing';
  return null;
}

/**
 * The expand frame's long-side cap in source pixels, from the pinned model's
 * catalog entry.
 * @param entry - The entry, undefined before the catalog is read.
 * @param entry.max_output_side - The model's longest output side, when it has one.
 * @returns The cap, unbounded for a model that sets none.
 * @throws {never} Never.
 */
export function expandCapOf(entry: { max_output_side?: number } | undefined): number {
  return entry?.max_output_side ?? Infinity;
}

/**
 * Whether a press makes something in the browser before the run: a browser
 * tool's file, or a drawing tool's images. The panel shows the press as under
 * way for that stretch, and the Space keeps the whole press as an operation
 * until it resolves.
 * @param spec - The tool.
 * @returns True when the press exports first.
 */
export function exportsBeforeRun(spec: MiniToolSpec): boolean {
  return spec.run.kind === 'browser' || spec.drawing !== undefined || spec.expand !== undefined;
}

/**
 * How the footer states the cost: a browser tool is free, a container tool is
 * billed on what it used, a model tool shows the yaml estimate.
 * @param spec - The tool.
 * @returns The mode.
 */
export function creditMode(spec: MiniToolSpec): CreditMode {
  if (spec.run.kind === 'browser') return 'free';
  if (spec.run.kind === 'container') return 'usage';
  return 'estimate';
}

/**
 * The width-to-height ratio an aspect choice locks the crop to.
 * @param aspect - `free`, `original` or `a:b`.
 * @param source - The source's size.
 * @returns The ratio, or null when free.
 */
export function aspectRatioOf(aspect: unknown, source: SourceSize): number | null {
  if (aspect === 'original') return source.width / source.height;
  if (typeof aspect !== 'string') return null;
  const match = /^(\d+):(\d+)$/.exec(aspect);
  if (match === null) return null;
  return Number(match[1]) / Number(match[2]);
}

/**
 * The largest rectangle of a ratio, centred in the source.
 * @param ratio - Width over height.
 * @param source - The source's size.
 * @returns The rectangle in whole pixels.
 */
export function rectForAspect(ratio: number, source: SourceSize): CropRect {
  const w = Math.min(source.width, Math.round(source.height * ratio));
  const h = Math.min(source.height, Math.round(w / ratio));
  return {
    x: Math.round((source.width - w) / 2),
    y: Math.round((source.height - h) / 2),
    w,
    h,
  };
}

/**
 * The rectangle after the reader types one side: a locked ratio moves the
 * other side, and the rectangle is kept inside the source from where it
 * starts.
 * @param rect - The rectangle now.
 * @param side - Which side was typed.
 * @param value - The typed size.
 * @param ratio - The locked ratio, or null when free.
 * @param source - The source's size.
 * @returns The new rectangle.
 */
export function setRectSide(
  rect: CropRect,
  side: 'w' | 'h',
  value: number,
  ratio: number | null,
  source: SourceSize,
): CropRect {
  const roomW = source.width - rect.x;
  const roomH = source.height - rect.y;
  const typed = Math.max(1, Math.round(value));
  if (ratio === null) {
    return side === 'w'
      ? { ...rect, w: Math.min(typed, roomW) }
      : { ...rect, h: Math.min(typed, roomH) };
  }
  let w = side === 'w' ? typed : typed * ratio;
  let h = side === 'h' ? typed : typed / ratio;
  const shrink = Math.min(1, roomW / w, roomH / h);
  w = Math.max(1, Math.round(w * shrink));
  h = Math.max(1, Math.round(h * shrink));
  return { ...rect, w, h };
}
