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

import { SOURCE_TYPES } from "@domain/model-catalog/mode-config.js";

/** How a parameter's value reaches the run. */
export const FILL_KINDS = [
  "canvas",
  "pool",
  "editor",
  "panel",
  "remote",
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
  when: z
    .object({
      source: z.string().optional(),
      flag_on: z.string().optional(),
      flag_off: z.string().optional(),
    })
    .optional(),
  modes: z.array(z.string()).optional(),
  note: z.string().optional(),
  // One spelling, because readers compare against this exact string: the
  // source gate takes anything that is not `list` as a single URL, while the
  // cap check and the transport iterate it. A capitalised spelling would pass
  // a plain string check and flip both of those answers.
  type: z.literal("list").optional(),
  max_items: z.number().optional(),
  max_items_when_present: z.record(z.string(), z.number()).optional(),
});

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
    const modes = new Set(Array.isArray(model.mode) ? model.mode : [model.mode ?? ""]);
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
      for (const fault of faultsOn(parsed.data, names, modes)) {
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
 * Everything one declaration says that the model around it denies.
 * @param declared - The declaration to check.
 * @param names - Every parameter name this model declares.
 * @param modes - Every mode this model serves.
 * @returns One sentence per fault; empty when the declaration holds.
 */
function faultsOn(
  declared: ParamDeclaration,
  names: ReadonlySet<string>,
  modes: ReadonlySet<string>,
): string[] {
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
  for (const gate of [declared.when?.source, declared.when?.flag_on, declared.when?.flag_off]) {
    if (gate !== undefined && !names.has(gate)) {
      faults.push(`when names "${gate}", which this model does not declare`);
    }
  }

  for (const mode of declared.modes ?? []) {
    if (!modes.has(mode)) {
      faults.push(`modes names "${mode}", which this model does not serve`);
    }
  }

  // A slot carries one file: the payload builders write a single string into
  // it. Raising the cap changes nothing a reader can use, so it is refused
  // rather than accepted and ignored (#266 is where slots learn to hold more).
  if (declared.fill === "canvas" && declared.type === "list" && (declared.max_items ?? 1) > 1) {
    faults.push(`a slot carries one file, and max_items is ${String(declared.max_items)}`);
  }

  // A cap counts entries, and only a list has entries. Readers split on this
  // exact field: the gate takes anything that is not `list` as one URL string,
  // while the cap check and the transport iterate it. A declaration carrying a
  // cap without the shape is read two ways at once, and the run it describes
  // is refused by one reader and iterated by the other.
  const capped =
    declared.max_items !== undefined || declared.max_items_when_present !== undefined;
  if (capped && declared.type !== "list") {
    const which = declared.max_items !== undefined ? "max_items" : "max_items_when_present";
    faults.push(`${which} counts entries, so this has to declare type: list`);
  }

  // The conditional cap states a LOWER number that takes over while another
  // param is filled, so it needs one to be lower than. The reader takes a
  // param with no `max_items` as uncapped and stops there, which makes a
  // declaration that states a cap and gets none.
  if (declared.max_items_when_present !== undefined && declared.max_items === undefined) {
    faults.push("max_items_when_present narrows a cap, so this has to declare max_items");
  }

  // Those keys name params of the same model, read by looking each one up
  // among the submitted values. A name from some other vendor's spelling is
  // never found, so the narrowing silently never applies and the wider cap
  // stands — the same failure the gate above is checked for.
  for (const named of Object.keys(declared.max_items_when_present ?? {})) {
    if (!names.has(named)) {
      faults.push(
        `max_items_when_present names "${named}", which this model does not declare`,
      );
    }
  }

  return faults;
}
