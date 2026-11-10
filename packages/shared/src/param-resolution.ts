// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one flow a run's settings go through before anything reads them
 * (inner#1691): fill the declared defaults, apply the model's forced values
 * until nothing changes, drop what a condition switches off. The panel, the
 * estimate, the submit endpoint, the agent tool and the worker all call it,
 * so each of them sees the params the upstream will receive.
 *
 * Beside it, the rule check those callers share: values, ranges, whole
 * numbers, text lengths, and a value the caller gave that a forced value
 * overrode.
 */

import { extractPromptText } from "@shared/agent/extract-prompt.js";
import { paramsForMode } from "@shared/param-modes.js";
import type { ParamBound, ParamDescriptor, ParamForce, ParamGate, ParamScalar } from "@shared/types/model-catalog.js";

/** What resolution reads off one declared param. */
export interface ResolvableParam {
  readonly default?: unknown;
  readonly values?: readonly unknown[];
  readonly min?: number;
  readonly max?: number;
  readonly type?: string;
  readonly when?: ParamGate;
  readonly bounds?: readonly ParamBound[];
  readonly max_length?: number;
}

/** What resolution reads off one model. */
export interface ResolvableModel {
  readonly params?: Readonly<Record<string, ResolvableParam>>;
  readonly forces?: readonly ParamForce[];
  readonly prompt_max_length?: number;
}

/** One rule a run's settings break, naming the param and the facts of the rule. */
export type ParamViolation =
  | { readonly param: string; readonly rule: "values"; readonly value: unknown; readonly values: readonly unknown[] }
  | { readonly param: string; readonly rule: "integer"; readonly value: unknown }
  | { readonly param: string; readonly rule: "text"; readonly value: unknown }
  | { readonly param: string; readonly rule: "bounds"; readonly value: number; readonly min?: number; readonly max?: number }
  | { readonly param: string; readonly rule: "max_length" | "prompt_max_length"; readonly length: number; readonly max: number }
  | {
      readonly param: string;
      readonly rule: "forced";
      readonly given: unknown;
      /** The forced value's id. */
      readonly force: string;
      /** The value it locks the param to. */
      readonly value: ParamScalar;
    };

/** Params after the forced values are applied, and which forced value set what. */
export interface AppliedForces {
  readonly params: Record<string, unknown>;
  /** Per param, the forced value that set it last. */
  readonly forcedBy: Readonly<Record<string, ParamForce>>;
  /** The ids that still changed something in the last round allowed; empty once settled. */
  readonly unsettled: readonly string[];
}

/**
 * The params a condition reads.
 * @param when - The condition.
 * @returns Their names, the switch first.
 */
export function gateParams(when: ParamGate): string[] {
  return [...(when.flag_on !== undefined ? [when.flag_on] : []), ...Object.keys(when.equals ?? {})];
}

/**
 * Whether a condition holds on a set of params.
 * @param when - The condition; every part given has to hold.
 * @param params - The params to read.
 * @returns True when it holds.
 */
export function gateHolds(when: ParamGate, params: Readonly<Record<string, unknown>>): boolean {
  if (when.flag_on !== undefined && params[when.flag_on] !== true) return false;
  return Object.entries(when.equals ?? {}).every(([key, value]) => params[key] === value);
}

/**
 * Apply forced values in declaration order, round after round until a round
 * changes nothing, for at most one round more than there are forced values.
 * @param forces - The model's forced values.
 * @param params - The params to apply them to; not modified.
 * @returns The params, who set what, and what still changed when the rounds ran out.
 */
export function applyForces(
  forces: readonly ParamForce[],
  params: Readonly<Record<string, unknown>>,
): AppliedForces {
  const out: Record<string, unknown> = { ...params };
  const forcedBy: Record<string, ParamForce> = {};
  let changedBy: string[] = [];
  for (let round = 0; round <= forces.length; round += 1) {
    changedBy = [];
    for (const force of forces) {
      if (!gateHolds(force.when, out)) continue;
      for (const [key, value] of Object.entries(force.set)) {
        forcedBy[key] = force;
        if (out[key] === value) continue;
        out[key] = value;
        if (!changedBy.includes(force.id)) changedBy.push(force.id);
      }
    }
    if (changedBy.length === 0) break;
  }
  return { params: out, forcedBy, unsettled: changedBy };
}

/**
 * Whether a value stands for "left blank" on this param.
 * @param spec - The param's declaration.
 * @param value - The value.
 * @returns True for nothing, and for an empty integer field.
 */
function isBlank(spec: ResolvableParam, value: unknown): boolean {
  return value === undefined || value === null || (spec.type === "integer" && value === "");
}

/**
 * Defaults filled and forced values applied, before conditions drop anything.
 * @param model - The model.
 * @param input - The params given, keyed by the catalog's names.
 * @returns The params and who forced what.
 */
function forced(model: ResolvableModel, input: Readonly<Record<string, unknown>>): AppliedForces {
  const filled: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    const value = input[name] === undefined ? spec.default : input[name];
    if (!isBlank(spec, value)) filled[name] = value;
  }
  return applyForces(model.forces ?? [], filled);
}

/**
 * The params a run actually sends: the declared defaults filled in, the
 * model's forced values applied, and every param whose condition does not
 * hold dropped, along with blank values and params the model does not declare.
 * @param model - The model.
 * @param input - The params given, keyed by the catalog's names.
 * @returns The resolved params.
 */
export function resolveParams(
  model: ResolvableModel,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out = { ...forced(model, input).params };
  const specs = model.params ?? {};
  // A dropped param no longer satisfies a condition naming it, so drop until stable.
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const name of Object.keys(out)) {
      const when = specs[name]?.when;
      if (when !== undefined && !gateHolds(when, out)) {
        delete out[name];
        dropped = true;
      }
    }
  }
  return out;
}

/**
 * Whether a run in this mode sends the prompt: the model takes one and its
 * `prompt_when`, when it has one, holds on the run's resolved params. Params
 * are stored per model across modes, so a choice made in another mode is
 * dropped before resolving: Mureka V9.5 Song composes from a melody without a
 * style prompt in Reference to Music, and still takes one in Text to Music.
 * @param model - The model.
 * @param model.takes_prompt - Whether it takes a prompt at all.
 * @param model.prompt_when - The condition its prompt is taken under.
 * @param mode - The mode the run is in; undefined for params already narrowed
 *   to it, as a submitted run's are.
 * @param params - The params stored for the model, or the run's own.
 * @returns True when the run sends the prompt.
 */
export function promptTaken(
  model: ResolvableModel & {
    readonly takes_prompt: boolean;
    readonly prompt_when?: ParamGate;
    readonly params?: Readonly<Record<string, ResolvableParam & Pick<ParamDescriptor, "modes">>>;
  },
  mode: string | undefined,
  params: Readonly<Record<string, unknown>>,
): boolean {
  if (!model.takes_prompt) return false;
  if (model.prompt_when === undefined) return true;
  const own = mode === undefined ? params : paramsForMode(params, model.params ?? {}, mode);
  return gateHolds(model.prompt_when, resolveParams(model, own));
}

/**
 * The range a number param holds to under the other params.
 * @param spec - The param's declaration.
 * @param params - The resolved params.
 * @returns The first conditional range whose condition holds, its missing ends
 *   taken from the param's own, or the param's own range.
 */
function boundsOf(spec: ResolvableParam, params: Readonly<Record<string, unknown>>): { min?: number; max?: number } {
  const found = spec.bounds?.find((bound) => gateHolds(bound.when, params));
  return { min: found?.min ?? spec.min, max: found?.max ?? spec.max };
}

/**
 * How many characters a text holds once cleaned, as the panel counts it.
 * @param text - The text.
 * @returns Its length in code points.
 */
function cleanedLength(text: string): number {
  return [...extractPromptText(text)].length;
}

/**
 * Every rule the run these params describe breaks: a value not offered, a
 * number out of its range or not whole, a text param that is not text, a text
 * too long once cleaned, and a
 * param given explicitly that a forced value changes.
 * @param model - The model.
 * @param input - The params given, keyed by the catalog's names; `prompt`
 *   beside them is checked against the model's prompt cap.
 * @returns The violations in declaration order; empty when the run is valid.
 */
export function checkParamCombination(
  model: ResolvableModel,
  input: Readonly<Record<string, unknown>>,
): ParamViolation[] {
  const found: ParamViolation[] = [];
  const specs = model.params ?? {};
  const prompt = input.prompt;
  if (typeof prompt === "string" && model.prompt_max_length !== undefined) {
    const length = cleanedLength(prompt);
    if (length > model.prompt_max_length) {
      found.push({ param: "prompt", rule: "prompt_max_length", length, max: model.prompt_max_length });
    }
  }
  const { params: afterForces, forcedBy } = forced(model, input);
  const resolved = resolveParams(model, input);
  for (const [param, spec] of Object.entries(specs)) {
    const given = input[param];
    const force = forcedBy[param];
    if (force !== undefined && !isBlank(spec, given) && given !== afterForces[param]) {
      found.push({ param, rule: "forced", given, force: force.id, value: afterForces[param] as ParamScalar });
      continue;
    }
    const value = resolved[param];
    if (value === undefined) continue;
    if (spec.values !== undefined) {
      if (!spec.values.includes(value)) found.push({ param, rule: "values", value, values: spec.values });
      continue;
    }
    if (spec.type === "integer" && !Number.isInteger(value)) {
      found.push({ param, rule: "integer", value });
      continue;
    }
    if (spec.type === "text" && typeof value !== "string") {
      found.push({ param, rule: "text", value });
      continue;
    }
    if (typeof value === "number") {
      const { min, max } = boundsOf(spec, resolved);
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        found.push({ param, rule: "bounds", value, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
      }
      continue;
    }
    if (typeof value === "string" && spec.max_length !== undefined) {
      const length = cleanedLength(value);
      if (length > spec.max_length) found.push({ param, rule: "max_length", length, max: spec.max_length });
    }
  }
  return found;
}
