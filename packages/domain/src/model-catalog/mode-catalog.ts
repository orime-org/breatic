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
  type ModelRate,
} from "@breatic/shared";
import { parse as parseYaml } from "yaml";

import { getModelCatalog } from "@domain/model-catalog/model-catalog.js";
import { SOURCE_TYPE_PARAM_FIELDS } from "@domain/model-catalog/source-requirement.js";

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
  /**
   * Where its values come from, for a field whose domain lives upstream.
   *
   * The two voice params are the case: their values are served by
   * `GET /models/:name/voices` rather than declared in yaml, so a field
   * presented without this reads as free text and gets guessed at.
   */
  valuesFrom?: string;
  /**
   * Whether the canvas fills this from the node wired into the generation
   * node, rather than the asker choosing it.
   *
   * A source slot renders like any other parameter otherwise, and an agent
   * told it may set the parameters it is shown will put a URL in it.
   */
  filledBySource?: boolean;
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
  /** What one call costs, for a model that bills per call. */
  credits: number;
  /**
   * What it charges per unit of what its vendor counts, when it bills that
   * way rather than per call.
   *
   * `cost_per_call` on such a model is the pre-enqueue balance floor, not the
   * price: sonilo states 5 as the floor and prices its longest preset at 36.
   * Reporting the floor as the price contradicts the number the panel shows
   * the user before they generate.
   */
  rate?: ModelRate;
  /** Roughly how long one call takes. */
  seconds: number;
  /**
   * Whether it consumes the text the user writes.
   *
   * A model that takes none has no prompt editor in its panel, so an answer
   * that does not say so has the agent telling the user to write one.
   */
  takesPrompt: boolean;
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
  // An empty or comment-only file parses to null, which would then be read
  // as an object one line later.
  modesConfigCache = (parseYaml(readFileSync(MODES_CONFIG_PATH, "utf-8")) ??
    {}) as Record<string, unknown>;
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
  for (const entry of entries) for (const mode of modesOf(entry)) backed.add(mode);
  return panelModes.filter((mode) => backed.has(mode));
}

/**
 * The modes one catalog entry declares.
 *
 * The field is one code or several, and the two readers of it have to agree
 * on that and on what an empty code means -- a mode reported as available
 * that the model lookup then matches nothing for renders as no models at all.
 * @param entry - The entry to read.
 * @returns Its modes, with empty codes dropped.
 */
function modesOf(entry: ModeSource): string[] {
  return (Array.isArray(entry.mode) ? entry.mode : [entry.mode]).filter(Boolean);
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
): { label: string; what: string } {
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
  // A mode the yaml does not describe is still a mode the picker offers and
  // the catalog backs. Dropping it here would have the two tools disagree:
  // this one would never name it while the other answers for it.
  return { label: mode, what: "" };
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
    const modes = usableModes(GENERATION_NODE_MODES[nodeType], entries).map(
      (mode) => ({ mode, ...describeMode(nodeType, mode) }),
    );
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
 * The parameter names this model takes from a wired node rather than the asker.
 *
 * Read off the source types the catalog already computed for this entry, and
 * the field table the execute gate already runs against, so the answer and the
 * gate cannot disagree about which fields a source fills.
 * @param entry - The model being described.
 * @param mode - The mode it is being described in.
 * @returns Every param name one of that mode's required sources arrives in.
 */
function sourceFilledFields(entry: ModelEntry, mode: string): Set<string> {
  const filled = new Set<string>();
  for (const sourceType of entry.sourcesByMode?.[mode] ?? []) {
    for (const [field] of SOURCE_TYPE_PARAM_FIELDS[sourceType]) filled.add(field);
  }
  return filled;
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
    .filter((entry) => modesOf(entry).includes(mode))
    .map((entry) => {
      const wiredFields = sourceFilledFields(entry, mode);
      return {
      name: entry.name,
      // The guide is written for a model to read and says what the thing is
      // good at; the description is written for a person and says what it is.
      // Either answers "should I propose this one", so take whichever exists.
      what: oneLine(entry.guide || entry.description || ""),
      credits: entry.cost_per_call,
      ...(entry.rate !== undefined ? { rate: entry.rate } : {}),
      seconds: entry.generation_time,
      takesPrompt: entry.takes_prompt,
      params: Object.fromEntries(
        Object.entries(entry.params).map(([name, spec]) => [
          name,
          {
            ...(spec.type !== undefined ? { type: spec.type } : {}),
            ...(spec.values !== undefined ? { values: spec.values as unknown[] } : {}),
            ...(spec.remote_source !== undefined
              ? { valuesFrom: spec.remote_source }
              : {}),
            ...(wiredFields.has(name) ? { filledBySource: true } : {}),
            default: spec.default,
            what: oneLine(spec.description ?? ""),
          },
        ]),
      ),
      };
    });
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
