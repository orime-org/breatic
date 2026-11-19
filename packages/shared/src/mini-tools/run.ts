// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a model tool's run is sent and when it is held back, for every caller
 * that runs one: the canvas's mini-tool panel and the MCP service
 * (breatic#1488 §9). The panel's own checks on what only it holds (a drawing,
 * an expand frame, a markup draft) stay with the panel.
 */

import type { ModelEntry } from "@shared/types/model-catalog.js";
import {
  defaultSizeTier,
  isModelTool,
  sizeTierOptions,
  type MiniToolSlotValue,
  type MiniToolSnapshot,
  type SizeTierOption,
} from "@shared/mini-tools/derive.js";
import type { MiniToolRequest, MiniToolRequestSlot } from "@shared/mini-tools/request-schema.js";
import type { MiniToolSlot, MiniToolSpec, ModelToolSpec } from "@shared/mini-tools/types.js";

/** What the source node is showing, as far as a run needs it. */
export interface MiniToolSourceInfo {
  width?: number | undefined;
  height?: number | undefined;
  /** Seconds. */
  duration?: number | undefined;
  /** Where the source plays from. */
  url?: string | undefined;
  /** What the ledger measured the stored file at, in bytes. */
  sizeBytes?: number | undefined;
}

/** A param chosen as an output size: its tiers on the source and the one in use. */
export interface SizeTierChoice {
  key: string;
  options: readonly SizeTierOption[];
  /** The tier the run takes; undefined when no tier is usable for the source. */
  selected: string | undefined;
}

/** The draft slots, by slot key. */
export type MiniToolSlots = Readonly<Record<string, MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined>>;

/**
 * The size tiers a model tool offers, as they fall on the source. The draft
 * holds the picked tier's label; a tier the source has outgrown is not kept.
 * @param spec - The tool.
 * @param entry - The pinned model's catalog entry.
 * @param draft - The draft params.
 * @param source - The source as the caller knows it.
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
 * The params a model tool's run is sent: its listed params on the pinned
 * model's defaults with the draft on top, a size tier sent as the megapixels
 * it comes to on the source, and nothing the panel hides while a slot is filled.
 * @param spec - The tool, a model tool.
 * @param entry - The pinned model's catalog entry.
 * @param draft - The draft params.
 * @param tiers - The size tiers as they fall on the source.
 * @param slots - The draft slots.
 * @returns The params by key.
 */
export function modelToolParams(
  spec: ModelToolSpec,
  entry: ModelEntry | undefined,
  draft: Readonly<Record<string, unknown>>,
  tiers: readonly SizeTierChoice[],
  slots: MiniToolSlots,
): Record<string, unknown> {
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
 * @returns True when an empty prompt holds the run back.
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
export function slotLengthCap(spec: MiniToolSpec, entry: ModelEntry | undefined, slots: MiniToolSlots): number | null {
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
 * The pinned model's ceiling a model tool's source is past (inner#1305 §7.3):
 * the length or the size its source param declares in the catalog. A source
 * whose length or size is not known is not held back; the model answers for it.
 * @param spec - The tool.
 * @param entry - The pinned model's catalog entry, undefined before the catalog is read.
 * @param source - What is known of the source.
 * @returns Which ceiling is passed and its value, or null when none is.
 */
export function sourceLimitOf(
  spec: MiniToolSpec,
  entry: ModelEntry | undefined,
  source: MiniToolSourceInfo,
): { kind: "duration" | "bytes"; limit: number } | null {
  if (!isModelTool(spec)) return null;
  const declared = entry?.params[spec.sourceParam];
  const maxSeconds = declared?.max_total_duration;
  if (maxSeconds !== undefined && source.duration !== undefined && source.duration > maxSeconds) {
    return { kind: "duration", limit: maxSeconds };
  }
  const maxBytes = declared?.max_bytes;
  if (maxBytes !== undefined && source.sizeBytes !== undefined && source.sizeBytes > maxBytes) {
    return { kind: "bytes", limit: maxBytes };
  }
  return null;
}

/**
 * The expand frame's long-side cap in source pixels, from the pinned model's
 * catalog entry.
 * @param entry - The entry, undefined before the catalog is read.
 * @param entry.max_output_side - The model's longest output side, when it has one.
 * @returns The cap, unbounded for a model that sets none.
 */
export function expandCapOf(entry: { max_output_side?: number } | undefined): number {
  return entry?.max_output_side ?? Infinity;
}

/**
 * One picked item as the request carries it.
 * @param value - The pick.
 * @returns Its address and length.
 */
function slotOf(value: MiniToolSlotValue): MiniToolRequestSlot {
  return { url: value.url, ...(value.duration !== undefined && { duration: value.duration }) };
}

/** What a server tool's run is built from. */
export interface MiniToolRequestInput {
  spec: MiniToolSpec;
  projectId: string;
  spaceId: string;
  /** The result nodes, in output order. */
  nodeIds: string[];
  /** The draft as it stood at the run. */
  snapshot: MiniToolSnapshot;
  /** What the source node records of its file. */
  source: { mimeType?: string | undefined; width?: number | undefined; height?: number | undefined };
  /** Images made for the run and uploaded before it: a drawing tool's mask or sketch, an expand's image and mask. */
  uploads: { drawing?: MiniToolRequest["drawing"]; expand?: MiniToolRequest["expand"] };
}

/**
 * The request a server tool's run sends.
 * @param input - What it is built from.
 * @returns The body of `POST /mini-tools`.
 */
export function miniToolRequestOf(input: MiniToolRequestInput): MiniToolRequest {
  const { spec, snapshot, source, uploads } = input;
  const slots: MiniToolRequest["slots"] = {};
  for (const slot of spec.slots) {
    const held = snapshot.slots[slot.key];
    if (held === undefined) continue;
    slots[slot.key] = Array.isArray(held) ? (held as readonly MiniToolSlotValue[]).map(slotOf) : slotOf(held as MiniToolSlotValue);
  }
  return {
    tool: spec.id,
    project_id: input.projectId,
    space_id: input.spaceId,
    node_ids: input.nodeIds,
    source: {
      url: snapshot.source.url,
      ...(source.mimeType !== undefined && { mime_type: source.mimeType }),
      ...(source.width !== undefined && { width: source.width }),
      ...(source.height !== undefined && { height: source.height }),
      ...(snapshot.source.duration !== undefined && { duration: snapshot.source.duration }),
    },
    ...(spec.prompt !== undefined && { prompt: snapshot.prompt }),
    params: { ...snapshot.params },
    slots,
    ...(uploads.drawing !== undefined && { drawing: uploads.drawing }),
    ...(uploads.expand !== undefined && { expand: uploads.expand }),
  };
}
