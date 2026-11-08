// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { CatalogShape, MediaBinding, ProviderConfigInput } from "../schema.js";

export const ROOT = resolve(__dirname, "../../../../..");
const MODALITIES = ["image", "video", "audio", "tts", "three_d"] as const;

/**
 * Read a yaml file under the repository's `config/`.
 * @param path - The path below `config/`.
 * @returns Its content.
 */
export const yaml = <T>(path: string): T => parse(readFileSync(resolve(ROOT, "config", path), "utf8")) as T;

/**
 * The provider configuration this repository ships, as an entry reads it.
 * @returns The raw configuration.
 */
export function shipped(): ProviderConfigInput {
  const models: ProviderConfigInput["media"]["models"] = {};
  for (const modality of MODALITIES) Object.assign(models, yaml<{ models: ProviderConfigInput["media"]["models"] }>(`provider/media/${modality}.yaml`).models);
  return {
    upstreams: yaml<{ upstreams: ProviderConfigInput["upstreams"] }>("provider/upstreams.yaml").upstreams,
    media: { models },
    llm: yaml<NonNullable<ProviderConfigInput["llm"]>>("provider/llm.yaml"),
  };
}

/** Our catalog's files, below `config/models/`. */
const CATALOG_FILES = ["image/models.yaml", "video/models.yaml", "audio/models.yaml", "tts/models.yaml", "three_d/models.yaml"] as const;

/** A catalog condition: the switch that must be on and the values params must hold; every part given must hold. */
export interface CatalogGate {
  flag_on?: string;
  equals?: Record<string, unknown>;
}

/** A range that replaces a number param's own while its condition holds; an end it leaves out is the param's own. */
export interface CatalogBound {
  when: CatalogGate;
  min?: number;
  max?: number;
}

/** One model of our catalog, as the files write it; the fields the provider checks are typed. */
export type CatalogModel = CatalogShape["models"][number] & {
  /** Per mode, the params of which a run must carry at least one. */
  source_groups?: { mode: string; any_of: string[] }[];
  /** The longest prompt the model takes, where it states one (`prompt_max_length` in the 3D catalog). */
  max_input_chars?: number;
  prompt_max_length?: number;
  /** Values the model forces while a condition holds, applied in order round after round until nothing changes. */
  forces?: { id: string; when: CatalogGate; set: Record<string, unknown> }[];
  [field: string]: unknown;
};

/** One param of our catalog, as far as resolving a run reads it. */
interface ResolvedParam {
  default?: unknown;
  type?: string;
  /** Sent only while this holds. */
  when?: CatalogGate;
}

/**
 * Whether a catalog condition holds on a run's params.
 * @param when - The condition.
 * @param params - The params.
 * @returns True when every part given holds.
 */
export function gateHolds(when: CatalogGate, params: Readonly<Record<string, unknown>>): boolean {
  if (when.flag_on !== undefined && params[when.flag_on] !== true) return false;
  return Object.entries(when.equals ?? {}).every(([key, value]) => params[key] === value);
}

/**
 * The params a run of a catalog model sends, resolved as the application resolves them before provider sees them
 * (`resolveParams` in `packages/shared/src/param-resolution.ts`, which provider may not import): each param given or at
 * its default, a blank one left out, the model's forced values applied round after round until nothing changes, then
 * every param whose condition does not hold dropped until none is.
 * @param model - The catalog model.
 * @param given - The params the run sets.
 * @returns The resolved params.
 */
export function resolvedParams(model: Pick<CatalogModel, "params" | "forces">, given: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const specs = model.params as Record<string, ResolvedParam>;
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = given[name] === undefined ? spec.default : given[name];
    if (value !== undefined && value !== null && !(spec.type === "integer" && value === "")) out[name] = value;
  }
  const forces = model.forces ?? [];
  for (let round = 0, changed = true; changed && round <= forces.length; round += 1) {
    changed = false;
    for (const force of forces) {
      if (!gateHolds(force.when, out)) continue;
      for (const [key, value] of Object.entries(force.set)) {
        if (out[key] === value) continue;
        out[key] = value;
        changed = true;
      }
    }
  }
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const name of Object.keys(out)) {
      const when = specs[name]?.when;
      if (when === undefined || gateHolds(when, out)) continue;
      delete out[name];
      dropped = true;
    }
  }
  return out;
}

/**
 * Our catalog: every model as its file writes it, `params` always present.
 * @returns The catalog.
 */
export function catalog(): { models: CatalogModel[] } {
  return { models: CATALOG_FILES.flatMap((f) => yaml<{ models: CatalogModel[] }>(`models/${f}`).models.map((m) => ({ ...m, params: m.params ?? {} }))) };
}

/** One of our catalog's params, as far as a request-body sample needs it. */
interface OfferedParam {
  values?: unknown[];
  min?: number;
  max?: number;
  bounds?: CatalogBound[];
}

/**
 * The ends a number param can reach: its own range's, and each conditional range's, an end a range leaves out its own.
 * @param param - The catalog's param.
 * @returns The distinct ends, or none for a param without a range.
 */
export function rangeEnds(param: OfferedParam | undefined): number[] {
  if (param?.min === undefined || param.max === undefined) return [];
  const ends = [param.min, param.max, ...(param.bounds ?? []).flatMap((b) => [b.min ?? param.min!, b.max ?? param.max!])];
  return [...new Set(ends)];
}

/**
 * The values of one param a reseller's request-body sample covers: each offered value the binding supports, the ends a
 * range reaches (`rangeEnds`), each voice of its voice map; an empty list when any value it takes will do.
 * @param name - Our param.
 * @param param - The catalog's param.
 * @param binding - The binding.
 * @returns The values.
 */
export function coveredValues(name: string, param: OfferedParam | undefined, binding: MediaBinding): unknown[] {
  const voices = binding.voice_map?.[name];
  const values = voices !== undefined ? Object.keys(voices) : param?.values ?? rangeEnds(param);
  const supported = binding.params?.[name]?.supported;
  return supported === undefined ? values : values.filter((v) => supported.includes(v as string | number | boolean));
}

/**
 * A condition's top-level ` or ` operands, so a vendor limit joined to a reseller's own is seen on its own.
 * @param when - The condition.
 * @returns Each operand outside any brackets.
 */
export function disjuncts(when: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < when.length; i++) {
    const c = when[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && when.startsWith(" or ", i)) {
      parts.push(when.slice(start, i));
      start = i + 4;
    }
  }
  return [...parts, when.slice(start)];
}
