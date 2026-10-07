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
  isModelTool,
  toolParamKeys,
  type MiniToolSlotValue,
  type MiniToolSpec,
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

/** Why Execute is held back, or null when it may run. */
export type MiniToolRefusal = 'sourceMissing' | 'slotMissing' | 'promptMissing' | 'exporting' | null;

/** How the panel's footer states the cost. */
export type CreditMode = 'free' | 'usage' | 'estimate';

/**
 * The params a run is sent: a model tool's listed params on the pinned model's
 * defaults with the draft on top; a local tool's draft as it stands.
 * @param spec - The tool.
 * @param entry - The pinned model's catalog entry, for a model tool.
 * @param draft - The panel's draft params.
 * @returns The params by key.
 */
export function resolvedParams(
  spec: MiniToolSpec,
  entry: ModelEntry | undefined,
  draft: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!isModelTool(spec)) return { ...draft };
  const out: Record<string, unknown> = {};
  for (const key of toolParamKeys(spec)) {
    const value = key in draft ? draft[key] : entry?.params[key]?.default;
    if (value !== undefined && value !== null) out[key] = value;
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
 * Why Execute is held back right now.
 * @param input - What the panel knows.
 * @param input.spec - The tool.
 * @param input.entry - The pinned model's catalog entry, for a model tool.
 * @param input.prompt - The draft prompt.
 * @param input.slots - The draft slots.
 * @param input.sourceShown - Whether the source node is showing its media.
 * @param input.exporting - Whether a browser tool's export is under way.
 * @returns The first reason in the order the reader would fix them, or null.
 */
export function miniToolRefusal(input: {
  spec: MiniToolSpec;
  entry: ModelEntry | undefined;
  prompt: string;
  slots: Readonly<Record<string, MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined>>;
  sourceShown: boolean;
  exporting: boolean;
}): MiniToolRefusal {
  const { spec, entry, prompt, slots, sourceShown, exporting } = input;
  if (exporting) return 'exporting';
  if (!sourceShown) return 'sourceMissing';
  for (const slot of spec.slots) {
    const held = slots[slot.key];
    const empty = held === undefined || (Array.isArray(held) && held.length === 0);
    if (empty && !slotOptional(entry, slot.param)) return 'slotMissing';
  }
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
