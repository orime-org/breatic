// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Hold a model's forced values and prompt cap to the model around them
 * (inner#1691, design 2.3).
 *
 * Forced values are applied round after round until nothing changes, so two
 * that keep rewriting the same param never settle, and the run they describe
 * has no single set of params. The loader tries every combination of the
 * switches and choices the forced values read or write, and refuses a model
 * where one of them is still changing when the rounds run out.
 */

import { applyForces } from "@breatic/shared";
import { z } from "zod";

import { conditionSchema } from "@domain/model-catalog/param-declaration.js";

/** One model, reduced to what these checks read. */
export interface ForcingModel {
  readonly name: string;
  readonly params?: Record<string, unknown>;
  readonly forces?: unknown;
  readonly prompt_max_length?: unknown;
}

const forcesSchema = z.array(
  z.strictObject({
    id: z.string().min(1),
    when: conditionSchema,
    set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    lock: z.boolean(),
  }),
);

/**
 * Every assignment of values to the given params.
 * @param domains - Each param with the values it can hold.
 * @returns One record per combination.
 */
function combinations(domains: ReadonlyArray<readonly [string, readonly unknown[]]>): Record<string, unknown>[] {
  return domains.reduce<Record<string, unknown>[]>(
    (acc, [name, values]) => acc.flatMap((partial) => values.map((value) => ({ ...partial, [name]: value }))),
    [{}],
  );
}

/**
 * Everything one model's forced values and prompt cap say that the model denies.
 * @param model - The model.
 * @returns One sentence per fault.
 */
function faultsOf(model: ForcingModel): string[] {
  const faults: string[] = [];
  if (
    model.prompt_max_length !== undefined &&
    !(typeof model.prompt_max_length === "number" && Number.isInteger(model.prompt_max_length) && model.prompt_max_length > 0)
  ) {
    faults.push("prompt_max_length has to be a positive whole number");
  }
  if (model.forces === undefined) return faults;
  const parsed = forcesSchema.safeParse(model.forces);
  if (!parsed.success) {
    return [...faults, ...parsed.error.issues.map((issue) => `forces.${issue.path.join(".")} ${issue.message}`)];
  }
  const forces = parsed.data;
  const params = model.params ?? {};
  const touched = new Set<string>();
  for (const force of forces) {
    const read = [...(force.when.flag_on !== undefined ? [force.when.flag_on] : []), ...Object.keys(force.when.equals ?? {})];
    for (const name of [...read, ...Object.keys(force.set)]) {
      touched.add(name);
      if (!(name in params)) faults.push(`forced value ${force.id} names "${name}", which this model does not declare`);
    }
    for (const [name, value] of Object.entries(force.set)) {
      const values = (params[name] as { values?: unknown[] } | undefined)?.values;
      if (values !== undefined && !values.includes(value)) {
        faults.push(`forced value ${force.id} sets ${name} to ${JSON.stringify(value)}, which it does not offer`);
      }
    }
  }
  if (faults.length > 0) return faults;
  const domains = [...touched].map((name) => {
    const values = (params[name] as { values?: unknown[] } | undefined)?.values;
    return [name, values ?? []] as const;
  });
  const open = domains.filter(([, values]) => values.length === 0).map(([name]) => name);
  if (open.length > 0) {
    return [`forced values read or write ${open.join(", ")}, which offer no values to check every combination over`];
  }
  for (const combination of combinations(domains)) {
    const { unsettled } = applyForces(forces, combination);
    if (unsettled.length > 0) {
      faults.push(`forced values ${unsettled.join(", ")} keep rewriting params from ${JSON.stringify(combination)} and never settle`);
      break;
    }
  }
  return faults;
}

/**
 * Refuse a modality where a model's forced values or prompt cap contradict it.
 * @param modality - The catalog bucket these models came from.
 * @param models - Its models.
 * @throws {Error} when a model's forced values are malformed, name what it does
 *   not declare, or never settle, or its prompt cap is not a positive whole number.
 */
export function assertForces(modality: string, models: readonly ForcingModel[]): void {
  const faults = models.flatMap((model) => faultsOf(model).map((fault) => `${model.name}: ${fault}`));
  if (faults.length === 0) return;
  throw new Error(`config/models/${modality}: forced values contradict their model — ${faults.join("; ")}`);
}
