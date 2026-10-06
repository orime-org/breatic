// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Hold each parameter's declaration to the model around it (#269).
 *
 * A declaration that contradicts the model is worse than a missing one: the
 * panel, the proposal tool and the pre-enqueue gate all read it, and each
 * answers around the contradiction in its own way -- a slot with no kind
 * draws nothing, a gate naming an absent parameter never opens, a parameter
 * scoped to a mode the model does not serve is simply never offered. None of
 * them reports anything. Refused while the catalog loads it is one message,
 * on the machine that ships the yaml.
 */

import { z } from "zod";

import { namedModes, SOURCE_TYPES } from "@domain/model-catalog/mode-config.js";

/** How a parameter's value reaches the run. */
export const FILL_KINDS = [
  "canvas",
  "pool",
  "editor",
  "panel",
  "remote",
  // Filled from the node's shots in the multi-shot mode (node-storyboard.ts).
  "storyboard",
  "none",
] as const;

/** One way a parameter's value reaches the run. */
export type FillKind = (typeof FILL_KINDS)[number];

/** One model, reduced to what these checks read. */
export interface ParamClaimant {
  /** The model's name, so a fault can say whose parameter it is. */
  readonly name: string;
  /** A single mode code, or several when one model serves more than one. */
  readonly mode?: string | readonly string[];
  /** Its parameters, as the yaml declares them. */
  readonly params?: Record<string, unknown>;
}

/**
 * The declaration fields, read leniently.
 *
 * Only the fields these checks compare are named, and every one is optional:
 * a parameter with no `fill` is what step 4 starts refusing, and reading it
 * strictly here would refuse today's catalog before it has been written.
 */
const declarationSchema = z.object({
  fill: z.enum(FILL_KINDS).optional(),
  accepts: z.enum(SOURCE_TYPES).optional(),
  optional: z.boolean().optional(),
  // Strict: the key set is closed, and a misspelled one used to be dropped in
  // silence — the control then read as waiting on nothing.
  when: z
    .strictObject({
      flag_on: z.string().optional(),
    })
    .optional(),
  modes: z.array(z.string()).optional(),
  note: z.string().optional(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  // What a new node stands on until the reader changes it (user 2026-09-29).
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  // The value that is sent as nothing: choosing it leaves the param out of the
  // request, for the upstream's own behaviour when it is absent ("auto").
  absent_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  // What a value is sent as upstream, keyed by its string form, when the
  // endpoint spells it differently (Kling's switch sends "intelligence").
  upstream_values: z.record(z.string(), z.string()).optional(),
  // A list the endpoint has no field for: each entry is written into the
  // prompt with this template.
  into_prompt: z.string().optional(),
  // How a value reads on screen, when its own spelling is not that sentence
  // (`left_right` reads "Left first"): a value of a choice or a step of a
  // range. English and never localized, like the model's own description.
  value_labels: z.record(z.string(), z.string()).optional(),
  // The BCP-47 tag each value is, in the order `values` lists them, so the
  // panel can show a language in the reader's own words (#2156, design §16).
  value_locales: z.array(z.string()).optional(),
  // One spelling each, because readers compare against these exact strings:
  // the source gate takes a `list` or `items` param as a list and anything
  // else as a single URL, while the cap check and the transport iterate lists;
  // `items` is a list editor whose entries carry `fields`; `text` is a free
  // text control.
  type: z.enum(["list", "items", "text"]).optional(),
  // Positive integers. A zero or a minus sign is read by every reader as no
  // cap at all, so it widens the limit the yaml meant to state; a fraction is
  // read as a cap and enforced, and there is no half a piece of material.
  max_items: z.number().int().positive().optional(),
  // The fewest entries a run takes; the panel keeps adding rows up to it.
  min_items: z.number().int().positive().optional(),
  // Another param this one stands in for: when this one is sent, that one is
  // not (Gemini's speakers make its single voice meaningless).
  replaces: z.string().optional(),
  // How a chip picked from this pool is written into the prompt the model
  // reads (#2156, design §13.2): `{n}` counts the sent list of this kind from
  // 1, `{i}` from 0.
  mention: z.string().optional(),
  // The upstream takes each entry of this list as an object with the URL
  // under this key (Krea's `reference: [{ image }]`).
  item_key: z.string().optional(),
  // The upstream has no field of its own for this slot: its files are
  // appended to the named pool and the prompt names them (inner#826).
  joins: z.string().optional(),
  // The sentence appended to the prompt for a joining slot; `{list}` becomes
  // the pool's mention of each appended file.
  prompt_note: z.string().optional(),
});

/** How many style images every model takes (user 2026-10-02, inner#826). */
const STYLE_IMAGES_HELD = 3;

/**
 * Every key a parameter declaration may carry.
 *
 * A key nobody reads was dropped in silence, so a misspelled `max_items` left
 * the param uncapped while the yaml said otherwise. The set lives here rather
 * than on the schema above, which is a narrow view: the keys from `description`
 * down are read elsewhere in the catalog and by the panel, not by these checks.
 */
const DECLARATION_KEYS: ReadonlySet<string> = new Set([
  "fill",
  "accepts",
  "optional",
  "when",
  "modes",
  "note",
  "type",
  "max_items",
  "min_items",
  "replaces",
  "description",
  "default",
  "values",
  "min",
  "max",
  "step",
  "remote_source",
  "upstream",
  "absent_value",
  "upstream_values",
  "into_prompt",
  "label",
  "value_labels",
  "value_locales",
  "fields",
  "mention",
  "item_key",
  "joins",
  "prompt_note",
]);

/** One parameter's declaration, as these checks read it. */
export type ParamDeclaration = z.infer<typeof declarationSchema>;

/**
 * Refuse a modality whose parameters declare something the model denies.
 * @param modality - The catalog bucket these models came from.
 * @param models - Its models with their parameter declarations.
 * @throws {Error} when a declaration contradicts the model around it.
 */
export function assertParamDeclarations(
  modality: string,
  models: readonly ParamClaimant[],
): void {
  const faults: string[] = [];
  for (const model of models) {
    const params = model.params ?? {};
    const names = new Set(Object.keys(params));
    const modes = new Set(namedModes(model));
    const pools = new Set(
      Object.entries(params)
        .filter(([, raw]) => (raw as { fill?: unknown } | null)?.fill === "pool")
        .map(([name]) => name),
    );
    const namedPools = new Set(
      [...pools].filter((pool) => typeof (params[pool] as { mention?: unknown }).mention === "string"),
    );
    for (const [param, raw] of Object.entries(params)) {
      const parsed = declarationSchema.safeParse(raw);
      if (!parsed.success) {
        // Every issue, each named by the field it is about: a declaration has
        // nine fields and three of them are closed sets, so a message on its
        // own leaves the reader guessing which one the parser refused.
        const said = parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ");
        faults.push(`${model.name}.${param}: ${said}`);
        continue;
      }
      for (const key of Object.keys(raw as Record<string, unknown>)) {
        if (!DECLARATION_KEYS.has(key)) {
          faults.push(`${model.name}.${param}: names "${key}", which no parameter declaration has`);
        }
      }
      for (const fault of faultsOn(parsed.data, { name: param, names, modes, pools, namedPools })) {
        faults.push(`${model.name}.${param}: ${fault}`);
      }
    }
  }
  if (faults.length === 0) return;
  throw new Error(
    `config/models/${modality}: parameter declarations contradict their model — ${faults.join("; ")}`,
  );
}

/**
 * Whether a control lets the reader pick the value a key spells.
 * @param declared - The declaration.
 * @param key - A value in its string form, as a yaml map key holds it.
 * @returns True for one of its `values`, or a step of its `min`/`max`/`step`
 * range counted from `min`, within float rounding.
 */
function offers(declared: ParamDeclaration, key: string): boolean {
  if (declared.values !== undefined) return declared.values.some((v) => String(v) === key);
  const { min, max, step } = declared;
  const at = Number(key);
  if (min === undefined || max === undefined || step === undefined || step <= 0 || key.trim() === "") return false;
  if (!Number.isFinite(at) || at < min || at > max) return false;
  const steps = (at - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/**
 * Everything one declaration says that the model around it denies.
 * @param declared - The declaration to check.
 * @param around - The model around it.
 * @param around.name - This parameter's own name.
 * @param around.names - Every parameter name this model declares.
 * @param around.modes - Every mode this model serves.
 * @param around.pools - The names of this model's pool parameters.
 * @param around.namedPools - The pools that say how their files are named.
 * @returns One sentence per fault; empty when the declaration holds.
 */
function faultsOn(
  declared: ParamDeclaration,
  around: {
    name: string;
    names: ReadonlySet<string>;
    modes: ReadonlySet<string>;
    pools: ReadonlySet<string>;
    namedPools: ReadonlySet<string>;
  },
): string[] {
  const { name, names, modes, pools, namedPools } = around;
  const faults: string[] = [];

  // No default: a parameter that says nothing would be read as having a
  // control the panel never drew, and nothing downstream would report it.
  if (declared.fill === undefined) {
    faults.push("fill is missing; say how this parameter gets filled");
  }

  // The reason is what the next reader needs, and it goes stale where it is
  // written far from the parameter it describes, so it is written here.
  if (declared.fill === "none" && (declared.note ?? "").trim() === "") {
    faults.push("fill: none needs a note saying why there is no control");
  }

  // The gate finds a carrier by what it accepts, so a place that says nothing
  // carries nothing: every submission through it is refused before it is sent.
  if (
    (declared.fill === "canvas" || declared.fill === "pool") &&
    declared.accepts === undefined
  ) {
    faults.push("a place material goes has to say which kind of node it takes (accepts)");
  }

  // A gate reads another parameter of the same model, so a name from some
  // other vendor's spelling leaves the control permanently shut.
  const gate = declared.when?.flag_on;
  if (gate !== undefined && !names.has(gate)) {
    faults.push(`when names "${gate}", which this model does not declare`);
  }

  // A label for a value the control does not offer is a label for nothing, and
  // usually a value renamed in one place and not the other.
  const offered = new Set((declared.values ?? []).map(String));
  for (const value of Object.keys(declared.value_labels ?? {})) {
    if (!offers(declared, value)) {
      faults.push(`value_labels names "${value}", which the control does not offer`);
    }
  }

  // A control the panel draws always stands on a value, and a new node reads
  // it here (user 2026-09-29): a choice on one of its values, a range on a
  // number inside it. Lists and free text start empty by nature.
  if (declared.fill === "panel" && declared.type === undefined) {
    const fallback = declared.default;
    if (declared.values !== undefined && declared.values.length > 0) {
      if (!declared.values.some((value) => value === fallback)) {
        faults.push("a panel choice has to default to one of its values");
      }
    } else if (declared.min !== undefined && declared.max !== undefined) {
      if (typeof fallback !== "number" || fallback < declared.min || fallback > declared.max) {
        faults.push("a panel range has to default to a number between its min and max");
      }
    }
  }

  // The payload leaves the param out when it holds this value, so a value the
  // choice does not offer is never held and the param is always sent.
  if (declared.absent_value !== undefined && !offered.has(String(declared.absent_value))) {
    faults.push(`absent_value "${declared.absent_value}" is not one of the values offered`);
  }

  // A spelling for a value the choice does not offer is never used, so a
  // misspelled key would leave the endpoint receiving our own spelling.
  for (const value of Object.keys(declared.upstream_values ?? {})) {
    if (!offered.has(value)) {
      faults.push(`upstream_values names "${value}", which values does not offer`);
    }
  }

  // Only a list of entries is written into the prompt, and a template with no
  // place for an entry's text would send every shot as the same words.
  if (declared.into_prompt !== undefined) {
    if (declared.type !== "items") {
      faults.push("into_prompt writes the entries of a list, so it needs type: items");
    } else if (!declared.into_prompt.includes("{prompt}")) {
      faults.push("into_prompt has no {prompt}, so no entry's text would reach the prompt");
    }
  }

  // One tag per value: the panel pairs them by position, so a short list
  // names the wrong language for every value past the gap.
  if (declared.value_locales !== undefined && declared.value_locales.length !== offered.size) {
    faults.push("value_locales has to name one locale per value, in the order values lists them");
  }

  // The payload drops the replaced param by name, so a name the model does
  // not declare drops nothing and both reach the upstream.
  if (declared.replaces !== undefined && !names.has(declared.replaces)) {
    faults.push(`replaces "${declared.replaces}", which this model does not declare`);
  }

  if (declared.min_items !== undefined) {
    if (declared.type !== "list" && declared.type !== "items") {
      faults.push("min_items counts entries, so this has to declare type: list or items");
    }
    if (declared.max_items !== undefined && declared.min_items > declared.max_items) {
      faults.push("min_items sits above max_items, so no run can satisfy both");
    }
  }

  for (const mode of declared.modes ?? []) {
    if (!modes.has(mode)) {
      faults.push(`modes names "${mode}", which this model does not serve`);
    }
  }

  // A list slot shows its thumbnails up to its cap and refuses past it, so it
  // has to state one.
  if (declared.fill === "canvas" && declared.type === "list" && declared.max_items === undefined) {
    faults.push("a list slot has to declare max_items, the most files it holds");
  }

  // Every model holds the same number of style images, so moving between
  // models never strands one the next model would not send.
  if (name === "style_images" && declared.max_items !== STYLE_IMAGES_HELD) {
    faults.push(`style_images holds ${STYLE_IMAGES_HELD} files on every model`);
  }

  if (declared.joins !== undefined) {
    // The files travel inside that pool, so it has to be one.
    if (!pools.has(declared.joins)) {
      faults.push(`joins "${declared.joins}", which is not one of this model's pools`);
    } else if (!namedPools.has(declared.joins)) {
      // The note names the files the way the pool writes its chips.
      faults.push(`joins "${declared.joins}", whose pool declares no mention to name its files by`);
    }
    // The prompt is the only place the upstream learns what the files are for.
    if (!declared.prompt_note?.includes("{list}")) {
      faults.push("a joining slot names its files in prompt_note with {list}");
    }
  }

  // A cap counts entries, and only a list has entries. Readers split on this
  // exact field: the gate takes anything that is not `list` as one URL string,
  // while the cap check and the transport iterate it. A declaration carrying a
  // cap without the shape is read two ways at once, and the run it describes
  // is refused by one reader and iterated by the other.
  if (declared.max_items !== undefined && declared.type !== "list" && declared.type !== "items") {
    faults.push("max_items counts entries, so this has to declare type: list or items");
  }

  if (declared.mention !== undefined) {
    // Only a chip the pool fills is numbered in a sent list; anywhere else
    // the spelling is read by nothing.
    if (declared.fill !== "pool") {
      faults.push("only a pool param writes its chips with a mention");
    }
    // One position per chip: none leaves every chip the same word, two make
    // the number ambiguous.
    if ((declared.mention.match(/\{[ni]\}/g) ?? []).length !== 1) {
      faults.push("a mention holds exactly one {n} or {i}");
    }
  }

  return faults;
}
