// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which modes a generation node can currently be set to, and what each is for.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";
import {
  CONTROL_GATES,
  GENERATION_NODE_BUCKETS,
  GENERATION_NODE_MODES,
  MODE_LABELS,
  REFERENCE_POOL_PARAM,
  MODE_SOURCE_FIELDS,
  PANEL_PARAM_CONTROLS,
  paramValues,
  type ControlGate,
  type GenerationNodeType,
  type ModelEntry,
  type ModelRate,
  type ParamDescriptor,
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

/** One generation node and the modes it can currently be set to. */
export interface NodeCapability {
  /** The kind of node these modes belong to. */
  nodeType: GenerationNodeType;
  /** What it can be set to, in the order its picker shows them. */
  modes: ModeInfo[];
}

/**
 * The modes each generation node can currently be set to.
 *
 * A list rather than a record keyed by node type, because the node type the
 * first tool reports is the one the second tool's enum accepts, and reading
 * it back out of a record's keys widens it to a plain string.
 */
export type CanvasCapabilities = NodeCapability[];

/** One catalog entry, reduced to the part that answers "which modes". */
interface ModeSource {
  /** A single mode code, or several when one model serves more than one. */
  mode: string | string[];
}

/**
 * One parameter of one model, as the agent needs it to fill the field in.
 *
 * Every field of `ParamDescriptor` that narrows what may be set is carried
 * here. The test of what belongs is not what an agent seems to need but
 * whether the catalog states a fact that changes the answer: a range stated
 * only in yaml is a range the reader is told nothing about, and the panel
 * builds its control out of exactly these.
 */
export interface ParamInfo {
  /** The value type the field takes. */
  type?: string;
  /**
   * The values the node's picker lists for it.
   *
   * A fixed set is listed as declared, and a range is walked the way a picker
   * walks it, so a reader is not offered a value no control can reach. The
   * image and video panels read this through the same function; the audio one
   * resolves its own controls in `audio-params.ts`, stating the same
   * precedence in its own words.
   */
  options?: unknown[];
  /** The low end, for a field whose domain is a range. */
  min?: number;
  /** The high end of that range. */
  max?: number;
  /** The distance between two settable values in that range. */
  step?: number;
  /** How many entries it takes, for a field that takes a list. */
  maxItems?: number;
  /**
   * How much tighter that cap gets when another field is filled.
   *
   * The reference list takes fewer images once a reference video is picked,
   * and the panel and the submit gate both enforce the tighter number. Stated
   * as its own clause because the answer describes a slot rather than one
   * submission, so there is no single number to give.
   */
  maxItemsWhen?: Readonly<Record<string, number>>;
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
  /**
   * Whether that source is the reference pool, which takes a second gesture.
   *
   * An edge makes an image available; an `@`-mention in the prompt picks it
   * for this run. A reader who only wires the edge submits a run with no
   * source, and the gate refuses it.
   */
  fromReferencePool?: true;
  /**
   * Whether this node's panel draws no control for it.
   *
   * The panel draws the controls it has, not one per declared parameter. A
   * parameter it cannot draw runs at whatever the upstream defaults to, and
   * presented as a field to fill it has the reader looking for a control that
   * is not there.
   */
  noControl?: true;
  /**
   * What has to hold before setting this counts for anything.
   *
   * Carried rather than flattened to a boolean, because a reader who satisfies
   * it gets the control: "not yet" and "not ever" ask different things of
   * them, and {@link ParamInfo.noControl} already says the second.
   */
  gate?: ControlGate;
  /** What it is set to when nobody chooses. */
  default: unknown;
  /** What it does, on one line. */
  what: string;
}

/** One model, as the agent needs it to decide whether to propose it. */
export interface ModelInfo {
  /** The name a node stores and a proposal names. */
  name: string;
  /**
   * The name the picker puts on screen.
   *
   * The picker renders this and never the id, so an answer carrying only the
   * id asks the reader to map a hyphenated lowercase id onto the spaced,
   * capitalised name in front of them.
   */
  displayName: string;
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
   * The most prompt text one call takes, for a model that states a cap.
   *
   * The panel refuses the submit past it, so two models that differ only
   * here are indistinguishable to a reader choosing on script length.
   */
  maxInputChars?: number;
  /**
   * Whether it consumes the text the user writes.
   *
   * A model that takes none has no prompt editor in its panel, so an answer
   * that does not say so has the agent telling the user to write one.
   */
  takesPrompt: boolean;
  /**
   * The node's other modes this entry serves, when it serves more than one.
   *
   * {@link ModelInfo.what} is written once for the whole entry, so an entry
   * serving two modes says things about the other one -- the image-to-video
   * models mention end-frame guidance, which is the first-last-frame mode.
   * Reading that sentence against a parameter list that has no end frame, a
   * reader takes the list for incomplete; naming the mode places it.
   */
  alsoServes?: string[];
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
  // The picker's word for it, never the catalog's: the mode code is nowhere on
  // screen, so this is the only thing a reader can match. Read once, because
  // both ways out of this function answer with the same name.
  const label = MODE_LABELS[nodeType][mode] ?? mode;
  for (const bucket of GENERATION_NODE_BUCKETS[nodeType]) {
    const modes = ((config[bucket] ?? {}) as Record<string, unknown>).modes as
      | Record<string, { label?: string; description?: string }>
      | undefined;
    const declared = modes?.[mode];
    if (!declared) continue;
    return {
      label,
      // One line: the yaml folds these across several, and the agent reads the
      // whole answer as a list.
      what: oneLine(declared.description ?? ""),
    };
  }
  // A mode the yaml does not describe is still a mode the picker offers and
  // the catalog backs. Dropping it here would have the two tools disagree:
  // this one would never name it while the other answers for it.
  return { label, what: "" };
}

/**
 * Every mode each generation node can currently be set to.
 *
 * A node with nothing left after filtering is absent rather than empty --
 * naming a node with no modes tells the model something is there.
 * @returns The modes per node type, in each picker's display order.
 */
export function getCanvasCapabilities(): CanvasCapabilities {
  const capabilities: CanvasCapabilities = [];
  for (const nodeType of Object.keys(GENERATION_NODE_MODES) as GenerationNodeType[]) {
    const entries = entriesForNode(nodeType);
    const modes = usableModes(GENERATION_NODE_MODES[nodeType], entries).map(
      (mode) => ({ mode, ...describeMode(nodeType, mode) }),
    );
    if (modes.length > 0) capabilities.push({ nodeType, modes });
  }
  return capabilities;
}

/**
 * Every catalog entry a generation node can draw on.
 *
 * Exported so a guard can hold the prose these entries carry to the same
 * reachability this answer uses: a claim only matters where a reader meets it.
 * @param nodeType - The node asking.
 * @returns The reachable models from each of that node's buckets.
 */
export function entriesForNode(nodeType: GenerationNodeType): ModelEntry[] {
  const catalog = getModelCatalog();
  return GENERATION_NODE_BUCKETS[nodeType].flatMap((bucket) => catalog[bucket] ?? []);
}

/**
 * How one parameter of one model is reached, in the mode being asked about.
 *
 * Three answers, and they decide what the reader is told to do with it: point
 * at another node, set it in the panel, or leave it be because this panel
 * draws nothing for it. A carrier field belonging to some other mode of the
 * same model is reached by nobody here, which is why the caller drops it.
 * @param name - The parameter name.
 * @param spec - What the catalog declares about it.
 * @param nodeType - The node asking.
 * @param mode - The mode it is asking about.
 * @returns What fills it, or "elsewhere" when this mode does not use it.
 */
function reachedBy(
  name: string,
  spec: ParamDescriptor,
  nodeType: GenerationNodeType,
  mode: string,
): "canvas" | "panel" | "nothing" | "elsewhere" {
  const byMode = MODE_SOURCE_FIELDS[nodeType];
  if ((byMode[mode] ?? []).includes(name)) return "canvas";
  // A carrier this node fills in some other mode. Read off the same table the
  // line above reads, so the two questions can never be answered from
  // different lists of what a source arrives in.
  if (Object.values(byMode).some((fields) => fields.includes(name))) return "elsewhere";
  // The voice picker locates its param by this marker rather than by name,
  // because its two vendors spell the same choice differently.
  if (spec.remote_source !== undefined) return "panel";
  if (!PANEL_PARAM_CONTROLS[nodeType].includes(name)) return "nothing";
  const gate = CONTROL_GATES[nodeType][name];
  // A control mounted on a slot this mode has no slot for is never drawn here.
  // A switch is on the panel either way, so a gate on one leaves it reachable.
  return gate?.kind !== "source" || (byMode[mode] ?? []).includes(gate.param)
    ? "panel"
    : "nothing";
}

/**
 * One parameter of one model, as the agent needs it.
 * @param name - The parameter name.
 * @param spec - What the catalog declares about it.
 * @param by - How {@link reachedBy} says it is filled.
 * @param entry - The model declaring it, for the picker's own value list.
 * @param nodeType - The node asking.
 * @returns Everything the catalog states about it that changes the answer.
 */
function projectParam(
  name: string,
  spec: ParamDescriptor,
  by: "canvas" | "panel" | "nothing",
  entry: ModelEntry,
  nodeType: GenerationNodeType,
): ParamInfo {
  // The picker's own list, so the reader is offered what the control offers.
  // A stepped range is a slider: its bounds and step say more than walking it.
  const options = spec.step === undefined ? paramValues(entry, name) : [];
  // A flag gate speaks about another parameter of the same model, and the
  // table is keyed by node type alone: a model declaring no such switch has no
  // state for the reader to put it in, so the clause names a control this
  // model never gets. The source kind is already held to this mode's slots.
  const declared = by === "panel" ? CONTROL_GATES[nodeType][name] : undefined;
  const gate =
    declared === undefined || declared.kind === "source" || declared.param in entry.params
      ? declared
      : undefined;
  return {
    ...(spec.type !== undefined ? { type: spec.type } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(spec.min !== undefined ? { min: spec.min } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    ...(spec.step !== undefined ? { step: spec.step } : {}),
    ...(spec.max_items !== undefined ? { maxItems: spec.max_items } : {}),
    ...(spec.max_items_when_present !== undefined
      ? { maxItemsWhen: spec.max_items_when_present }
      : {}),
    ...(spec.remote_source !== undefined ? { valuesFrom: spec.remote_source } : {}),
    ...(by === "canvas" ? { filledBySource: true as const } : {}),
    ...(by === "canvas" && name === REFERENCE_POOL_PARAM
      ? { fromReferencePool: true as const }
      : {}),
    ...(by === "nothing" ? { noControl: true as const } : {}),
    ...(gate !== undefined ? { gate } : {}),
    default: spec.default,
    what: oneLine(spec.description ?? ""),
  };
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
 */
export function modelsForMode(
  nodeType: GenerationNodeType,
  mode: string,
): ModelsForMode {
  const panelModes = GENERATION_NODE_MODES[nodeType];
  const entries = entriesForNode(nodeType);
  const usable = usableModes(panelModes, entries);
  if (!usable.includes(mode)) return { available: false, offered: usable };
  const models = entries
    .filter((entry) => modesOf(entry).includes(mode))
    .map((entry) => {
      // Only this node's modes: an entry also serving a mini-tool operation
      // names one the picker never offers, which is a mode to nobody here.
      const others = modesOf(entry).filter(
        (other) => other !== mode && panelModes.includes(other),
      );
      const reached = Object.entries(entry.params).map(
        ([name, spec]) => [name, spec, reachedBy(name, spec, nodeType, mode)] as const,
      );
      return {
      name: entry.name,
      displayName: entry.display_name,
      // The guide is written for a model to read and says what the thing is
      // good at; the description is written for a person and says what it is.
      // Either answers "should I propose this one", so take whichever exists.
      what: oneLine(entry.guide || entry.description || ""),
      credits: entry.cost_per_call,
      ...(entry.rate !== undefined ? { rate: entry.rate } : {}),
      seconds: entry.generation_time,
      ...(entry.max_input_chars !== undefined
        ? { maxInputChars: entry.max_input_chars }
        : {}),
      takesPrompt: entry.takes_prompt,
      ...(others.length > 0 ? { alsoServes: others } : {}),
      params: Object.fromEntries(
        reached
          // A carrier field this mode does not use belongs to another mode of
          // the same model: nothing here fills it and nothing may set it.
          .filter(([, , by]) => by !== "elsewhere")
          .map(([name, spec, by]) => [
            name,
            projectParam(name, spec, by as "canvas" | "panel" | "nothing", entry, nodeType),
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
