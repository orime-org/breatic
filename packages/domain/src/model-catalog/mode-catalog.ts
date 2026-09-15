// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which modes a generation node can currently be set to, and what each is for.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";
import {
  GENERATION_NODE_BUCKETS,
  GENERATION_NODE_MODES,
  type GenerationNodeType,
  type ModelEntry,
} from "@breatic/shared";
import { parse as parseYaml } from "yaml";

import { getModelCatalog } from "@domain/model-catalog/model-catalog.js";

const MODES_CONFIG_PATH = resolve(MONOREPO_ROOT, "config/models/modes.yaml");

/** What one mode is called and what it does, as the agent reads it. */
export interface ModeInfo {
  /** The mode code, which is what a node stores and a proposal names. */
  mode: string;
  /** The product's name for it, as the picker shows it. */
  label: string;
  /** What it does, on one line. */
  what: string;
}

/** The modes each generation node can currently be set to. */
export type CanvasCapabilities = Partial<Record<GenerationNodeType, ModeInfo[]>>;

/** One catalog entry, reduced to the part that answers "which modes". */
interface ModeSource {
  /** A single mode code, or several when one model serves more than one. */
  mode: string | string[];
}

/** One parameter of one model, as the agent needs it to fill the field in. */
export interface ParamInfo {
  /** The value type the field takes. */
  type?: string;
  /** The values it accepts, when it accepts a fixed set. */
  values?: unknown[];
  /** What it is set to when nobody chooses. */
  default: unknown;
  /** What it does, on one line. */
  what: string;
}

/** One model, as the agent needs it to decide whether to propose it. */
export interface ModelInfo {
  /** The name a node stores and a proposal names. */
  name: string;
  /** What it is good at, on one line. */
  what: string;
  /** What one call costs. */
  credits: number;
  /** Roughly how long one call takes. */
  seconds: number;
  /** Its parameters, keyed by the name the node stores them under. */
  params: Record<string, ParamInfo>;
}

/** What one node can do in one mode: the models, or why there are none. */
export type ModelsForMode =
  | { available: true; models: ModelInfo[] }
  | { available: false; offered: string[] };

let modesConfigCache: Record<string, unknown> | null = null;

/**
 * The parsed `config/models/modes.yaml`, read once per process.
 * @returns The mode definitions keyed by catalog bucket; empty when absent.
 */
function getModesConfig(): Record<string, unknown> {
  if (modesConfigCache) return modesConfigCache;
  if (!existsSync(MODES_CONFIG_PATH)) return {};
  modesConfigCache = parseYaml(readFileSync(MODES_CONFIG_PATH, "utf-8")) as Record<
    string,
    unknown
  >;
  return modesConfigCache;
}

/**
 * The modes a picker offers that the catalog can currently back.
 *
 * Both halves are load-bearing and neither can stand in for the other. The
 * panel lists are product decisions written down rather than rules to derive
 * (`VIDEO_GENERATION_MODES` says so in as many words), so a mode with models
 * behind it that no picker offers is a mini-tool operation, not something a
 * generation node can be set to. A mode the picker offers with nothing behind
 * it is the other half: declared, unbuilt, and not worth telling anyone about.
 * @param panelModes - The modes this node's picker offers, in display order.
 * @param entries - The catalog entries that could back them.
 * @returns The offered modes at least one entry declares, in the panel's order.
 */
export function usableModes(
  panelModes: readonly string[],
  entries: readonly ModeSource[],
): string[] {
  const backed = new Set<string>();
  for (const entry of entries) {
    const modes = Array.isArray(entry.mode) ? entry.mode : [entry.mode];
    for (const mode of modes) if (mode) backed.add(mode);
  }
  return panelModes.filter((mode) => backed.has(mode));
}

/**
 * One mode's definition from the yaml, looked up across the node's buckets.
 * @param nodeType - The node whose buckets to search.
 * @param mode - The mode code to describe.
 * @returns Its label and description, or undefined when the yaml omits it.
 */
function describeMode(
  nodeType: GenerationNodeType,
  mode: string,
): { label: string; what: string } | undefined {
  const config = getModesConfig();
  for (const bucket of GENERATION_NODE_BUCKETS[nodeType]) {
    const modes = ((config[bucket] ?? {}) as Record<string, unknown>).modes as
      | Record<string, { label?: string; description?: string }>
      | undefined;
    const declared = modes?.[mode];
    if (!declared) continue;
    return {
      label: declared.label ?? mode,
      // One line: the yaml folds these across several, and the agent reads the
      // whole answer as a list.
      what: oneLine(declared.description ?? ""),
    };
  }
  return undefined;
}

/**
 * Every mode each generation node can currently be set to.
 *
 * A node with nothing left after filtering is absent rather than empty --
 * naming a node with no modes tells the model something is there.
 * @returns The modes per node type, in each picker's display order.
 */
export function getCanvasCapabilities(): CanvasCapabilities {
  const capabilities: CanvasCapabilities = {};
  for (const nodeType of Object.keys(GENERATION_NODE_MODES) as GenerationNodeType[]) {
    const entries = entriesFor(nodeType);
    const modes = usableModes(GENERATION_NODE_MODES[nodeType], entries)
      .map((mode) => {
        const described = describeMode(nodeType, mode);
        return described ? { mode, ...described } : undefined;
      })
      .filter((mode): mode is ModeInfo => mode !== undefined);
    if (modes.length > 0) capabilities[nodeType] = modes;
  }
  return capabilities;
}

/**
 * Every catalog entry a generation node can draw on.
 * @param nodeType - The node asking.
 * @returns The reachable models from each of that node's buckets.
 */
function entriesFor(nodeType: GenerationNodeType): ModelEntry[] {
  const catalog = getModelCatalog();
  return GENERATION_NODE_BUCKETS[nodeType].flatMap((bucket) => catalog[bucket] ?? []);
}

/**
 * The models one generation node can use in one mode.
 *
 * A mode the node cannot be set to is answered as such rather than with an
 * empty list: "this node does not do that, here is what it does" and "this is
 * configured with nothing" are different answers, and an empty array reads as
 * the second whichever one is true.
 * @param nodeType - The node asking.
 * @param mode - The mode it is asking about.
 * @returns The models, or the modes it could ask about instead.
 * @throws {RangeError} When `nodeType` is not a generation node.
 */
export function modelsForMode(
  nodeType: GenerationNodeType,
  mode: string,
): ModelsForMode {
  const panelModes = GENERATION_NODE_MODES[nodeType];
  if (!panelModes) throw new RangeError(`Not a generation node: ${nodeType}`);
  const entries = entriesFor(nodeType);
  const usable = usableModes(panelModes, entries);
  if (!usable.includes(mode)) return { available: false, offered: usable };
  const models = entries
    .filter((entry) => {
      const declared = Array.isArray(entry.mode) ? entry.mode : [entry.mode];
      return declared.includes(mode);
    })
    .map((entry) => ({
      name: entry.name,
      // The guide is written for a model to read and says what the thing is
      // good at; the description is written for a person and says what it is.
      // Either answers "should I propose this one", so take whichever exists.
      what: oneLine(entry.guide || entry.description || ""),
      credits: entry.cost_per_call,
      seconds: entry.generation_time,
      params: Object.fromEntries(
        Object.entries(entry.params).map(([name, spec]) => [
          name,
          {
            ...(spec.type !== undefined ? { type: spec.type } : {}),
            ...(spec.values !== undefined ? { values: spec.values as unknown[] } : {}),
            default: spec.default,
            what: oneLine(spec.description ?? ""),
          },
        ]),
      ),
    }));
  return { available: true, models };
}

/**
 * One line of text, with the yaml's folding undone.
 * @param text - The declared text, which the yaml may have folded.
 * @returns The same words on one line.
 */
function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
