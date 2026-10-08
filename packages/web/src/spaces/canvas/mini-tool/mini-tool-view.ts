// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a mini-tool panel shows and whether it may run (inner#888 §7), as pure
 * functions over the registry, the pinned model's catalog entry and the draft.
 */

import {
  type ModelEntry,
} from '@breatic/shared';
import {
  defaultSizeTier,
  isModelTool,
  sizeTierOptions,
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
}

/** A param chosen as an output size: its tiers on the source and the one in use. */
export interface SizeTierChoice {
  key: string;
  options: readonly SizeTierOption[];
  /** The tier the run takes; undefined when none enlarges the source. */
  selected: string | undefined;
}

/** Why Execute is held back, or null when it may run. */
export type MiniToolRefusal =
  | 'sourceMissing'
  | 'alreadyLargest'
  | 'slotMissing'
  | 'slotTooLong'
  | 'promptMissing'
  | 'exporting'
  | null;

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
    const options = sizeTierOptions(param.sizeTiers, size, entry?.params[param.key]?.max);
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
 * @returns The params by key.
 */
export function resolvedParams(
  spec: MiniToolSpec,
  entry: ModelEntry | undefined,
  draft: Readonly<Record<string, unknown>>,
  source: MiniToolSourceInfo = {},
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
  const tiers = new Map(sizeTierChoices(spec, entry, draft, source).map((choice) => [choice.key, choice]));
  const out: Record<string, unknown> = {};
  for (const param of spec.params) {
    if (param.sizeTiers !== undefined) {
      const choice = tiers.get(param.key);
      const tier = choice?.options.find((option) => option.label === choice.selected);
      if (tier !== undefined) out[param.key] = tier.megapixels;
      continue;
    }
    const value = param.key in draft ? draft[param.key] : entry?.params[param.key]?.default;
    if (value !== undefined && value !== null) out[param.key] = value;
  }
  return out;
}

/**
 * Whether a slot may stay empty: its yaml param says `optional`.
 * @param entry - The pinned model's catalog entry.
 * @param param - The param the slot fills.
 * @returns True when the run goes without it.
 */
function slotOptional(entry: ModelEntry | undefined, param: string): boolean {
  return entry?.params[param]?.optional === true;
}

/**
 * Whether the run must carry a prompt: the tool draws a prompt box and its
 * pinned model takes one.
 * @param spec - The tool.
 * @param entry - The pinned model's catalog entry.
 * @returns True when an empty prompt holds Execute back.
 */
export function promptRequired(spec: MiniToolSpec, entry: ModelEntry | undefined): boolean {
  return spec.prompt !== undefined && entry?.takes_prompt === true;
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
  slots: Readonly<Record<string, MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined>>,
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
 * Why Execute is held back right now.
 * @param input - What the panel knows.
 * @param input.spec - The tool.
 * @param input.entry - The pinned model's catalog entry, for a model tool.
 * @param input.prompt - The draft prompt.
 * @param input.slots - The draft slots.
 * @param input.sourceShown - Whether the source node is showing its media.
 * @param input.source - The source as the panel knows it.
 * @param input.exporting - Whether a browser tool's export is under way.
 * @returns The first reason in the order the reader would fix them, or null.
 */
export function miniToolRefusal(input: {
  spec: MiniToolSpec;
  entry: ModelEntry | undefined;
  prompt: string;
  slots: Readonly<Record<string, MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined>>;
  sourceShown: boolean;
  source?: MiniToolSourceInfo;
  exporting: boolean;
}): MiniToolRefusal {
  const { spec, entry, prompt, slots, sourceShown, source = {}, exporting } = input;
  if (exporting) return 'exporting';
  if (!sourceShown) return 'sourceMissing';
  // A range is measured on the source's length, which arrives with its metadata.
  const measuresLength = !isModelTool(spec) && spec.params.some((param) => param.kind === 'range');
  if (measuresLength && source.duration === undefined) return 'sourceMissing';
  // A size tier is measured on the source's pixel size, which arrives the same way.
  const measuresSize = isModelTool(spec) && spec.params.some((param) => param.sizeTiers !== undefined);
  if (measuresSize) {
    const choices = sizeTierChoices(spec, entry, {}, source);
    if (choices.length === 0) return 'sourceMissing';
    if (choices.some((choice) => choice.selected === undefined)) return 'alreadyLargest';
  }
  for (const slot of spec.slots) {
    const held = slots[slot.key];
    const empty = held === undefined || (Array.isArray(held) && held.length === 0);
    if (empty && !slotOptional(entry, slot.param)) return 'slotMissing';
  }
  if (slotLengthCap(spec, entry, slots) !== null) return 'slotTooLong';
  if (promptRequired(spec, entry) && prompt.trim() === '') return 'promptMissing';
  return null;
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
