// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the web, the server and the worker read off the registry (inner#888
 * §5). Pure functions over {@link MINI_TOOLS}, so nothing here is a second
 * copy of a declaration.
 */

import { defaultAdjustValue } from "@shared/adjust-value.js";
import { MINI_TOOLS } from "@shared/mini-tools/tools.js";
import type { MiniToolParam, MiniToolSpec, ModelToolSpec, SizeTier } from "@shared/mini-tools/types.js";
import type { EstimateInput } from "@shared/pricing/estimate.js";
import type { ModelCatalog, ModelEntry, ParamDescriptor } from "@shared/types/model-catalog.js";
import { paramValueAllowed } from "@shared/types/param-values.js";

/** One piece of media picked into a slot. */
export interface MiniToolSlotValue {
  readonly url: string;
  readonly cover?: string;
  /** Seconds, when the medium has a length. */
  readonly duration?: number;
}

/** What a run was started with: the panel's draft at the moment Execute was pressed. */
export interface MiniToolSnapshot {
  readonly params: Readonly<Record<string, unknown>>;
  readonly prompt: string;
  readonly source: { readonly url: string; readonly duration?: number };
  readonly slots: Readonly<Record<string, MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined>>;
}

const BY_ID = new Map(MINI_TOOLS.map((tool) => [tool.id, tool]));

/**
 * The tool declared under an id.
 * @param id - The tool id.
 * @returns The declaration, or undefined for an id the registry does not hold.
 */
export function miniToolById(id: string): MiniToolSpec | undefined {
  return BY_ID.get(id);
}

/**
 * The tools a node of this type offers, in submenu order.
 * @param type - The node's type.
 * @returns The tools whose source is that type; empty for every other kind.
 */
export function miniToolsFor(type: string): readonly MiniToolSpec[] {
  return MINI_TOOLS.filter((tool) => tool.source === type);
}

/**
 * The catalog entry with this name, in whichever modality bucket holds it.
 * @param catalog - The model catalog.
 * @param name - The model name.
 * @returns The entry, or undefined when the catalog does not serve it.
 */
export function catalogEntryOf(catalog: ModelCatalog, name: string): ModelEntry | undefined {
  for (const bucket of [catalog.image, catalog.video, catalog.audio, catalog.tts, catalog.three_d]) {
    const entry = bucket.find((model) => model.name === name);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/**
 * The tools a node of this type can open now: every browser and container
 * tool, and the model tools whose pinned model the catalog serves.
 * @param type - The node's type.
 * @param catalog - The model catalog, or undefined before it has loaded.
 * @returns The tools in submenu order.
 */
export function servedMiniToolsFor(type: string, catalog: ModelCatalog | undefined): readonly MiniToolSpec[] {
  return miniToolsFor(type).filter((tool) => {
    if (!isModelTool(tool)) return true;
    return catalog !== undefined && catalogEntryOf(catalog, tool.run.model) !== undefined;
  });
}

/**
 * Whether a tool runs on a pinned catalog model.
 * @param spec - The tool.
 * @returns True for a model tool.
 */
export function isModelTool(spec: MiniToolSpec): spec is ModelToolSpec {
  return spec.run.kind === "model";
}

/**
 * The catalog model a model tool is pinned to.
 * @param spec - The tool.
 * @returns The model name, or undefined for a browser or container tool.
 */
export function modelOf(spec: MiniToolSpec): string | undefined {
  return isModelTool(spec) ? spec.run.model : undefined;
}

/**
 * The yaml params a model tool's panel exposes: the only keys its draft,
 * request body and validation accept.
 * @param spec - The tool.
 * @returns The keys, empty for a browser or container tool.
 */
export function toolParamKeys(spec: MiniToolSpec): readonly string[] {
  return isModelTool(spec) ? spec.params.map((param) => param.key) : [];
}

/** No turn and no flip: the picture as it is, the orientation param's default. */
export const UPRIGHT: Readonly<{ turns: number; flipX: boolean; flipY: boolean }> = Object.freeze({
  turns: 0,
  flipX: false,
  flipY: false,
});

/**
 * The starting value of one declared param.
 * @param param - The param.
 * @returns Its default; null for a rectangle or range that waits on the source's size.
 */
function defaultOf(param: MiniToolParam): unknown {
  switch (param.kind) {
    case "number":
    case "enum":
      return param.default;
    case "rect":
    case "range":
      return null;
    case "adjust":
      return { ...defaultAdjustValue };
    case "orient":
      return { ...UPRIGHT };
  }
}

/**
 * The panel label of a browser or container tool's param. A model tool's
 * params are labelled as the generation panel labels them.
 * @param key - The param's key.
 * @returns The message key.
 */
export function localParamLabelKey(key: string): string {
  return `canvas.miniTool.param.${key}.label`;
}

/**
 * A browser or container tool's starting params. A model tool's draft is
 * resolved from its catalog entry when the panel opens, so it starts empty.
 * @param spec - The tool.
 * @returns The params keyed by name.
 */
export function defaultParamsOf(spec: MiniToolSpec): Record<string, unknown> {
  if (isModelTool(spec)) return {};
  return Object.fromEntries(spec.params.map((param) => [param.key, defaultOf(param)]));
}

/** One size tier as it falls on a source. */
export interface SizeTierOption {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** What the run is sent, to two decimals. */
  readonly megapixels: number;
  /** False when the tier would not enlarge the source or passes the model's ceiling. */
  readonly usable: boolean;
}

/** The tier picked when the reader has not chosen one. */
const DEFAULT_SIZE_TIER = "4K";

/**
 * Each tier's output on a source: its long edge scaled to the tier's, the
 * short edge keeping the source's proportion.
 * @param tiers - The param's tiers.
 * @param source - The source's pixel size.
 * @param source.width - Its width.
 * @param source.height - Its height.
 * @param declared - The pinned model's declaration of the param, whose range the
 * server holds every run to.
 * @returns One option per tier, in order.
 */
export function sizeTierOptions(
  tiers: readonly SizeTier[],
  source: { width: number; height: number },
  declared: Pick<ParamDescriptor, "values" | "min" | "max" | "type"> | undefined,
): SizeTierOption[] {
  const long = Math.max(source.width, source.height);
  return tiers.map((tier) => {
    const scale = tier.longEdge / long;
    const width = Math.round(source.width * scale);
    const height = Math.round(source.height * scale);
    const megapixels = Math.round((width * height) / 10_000) / 100;
    const usable = tier.longEdge > long && paramValueAllowed(declared ?? {}, megapixels);
    return { label: tier.label, width, height, megapixels, usable };
  });
}

/**
 * The params a tool measures as output sizes on its source.
 * @param spec - The tool.
 * @returns Their keys; empty for a tool with none.
 */
export function tieredParamKeys(spec: MiniToolSpec): string[] {
  return isModelTool(spec) ? spec.params.filter((param) => param.sizeTiers !== undefined).map((param) => param.key) : [];
}

/**
 * The tier a run takes when the reader has not picked one: 4K when it can be
 * used, otherwise the first that can.
 * @param options - The tiers on the source.
 * @returns The tier's label, or undefined when none enlarges the source.
 */
export function defaultSizeTier(options: readonly SizeTierOption[]): string | undefined {
  const usable = options.filter((option) => option.usable);
  return (usable.find((option) => option.label === DEFAULT_SIZE_TIER) ?? usable[0])?.label;
}

/**
 * Durations of the picked media, when every one is known.
 * @param values - The media a param carries.
 * @returns Their lengths in order, or undefined while any is unknown.
 */
function knownDurations(values: readonly MiniToolSlotValue[]): number[] | undefined {
  const lengths = values.map((value) => value.duration);
  return lengths.every((length): length is number => length !== undefined) ? lengths : undefined;
}

/**
 * The estimate input of one run: the draft params first, then the source and
 * every filled slot written under the model params they fill.
 * @param spec - The tool.
 * @param snapshot - What the run reads.
 * @returns The input `estimateCredits` takes for the pinned model.
 */
export function miniToolEstimateInput(spec: MiniToolSpec, snapshot: MiniToolSnapshot): EstimateInput {
  const params: Record<string, unknown> = { ...snapshot.params, [spec.sourceParam]: snapshot.source.url };
  const durations: Record<string, readonly number[]> = {};
  const sourceLength = knownDurations([snapshot.source]);
  if (sourceLength) durations[spec.sourceParam] = sourceLength;
  for (const slot of spec.slots) {
    const filled = snapshot.slots[slot.key];
    if (filled === undefined) continue;
    const list = Array.isArray(filled) ? (filled as readonly MiniToolSlotValue[]) : [filled as MiniToolSlotValue];
    params[slot.param] = slot.many ? list.map((value) => value.url) : list[0]?.url;
    const lengths = knownDurations(list);
    if (lengths) durations[slot.param] = lengths;
  }
  return {
    params,
    prompt: snapshot.prompt,
    durations,
    sources: [spec.sourceParam, ...spec.slots.map((slot) => slot.param)],
  };
}
