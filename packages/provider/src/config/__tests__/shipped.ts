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

/** One model of our catalog, as the files write it; the fields the provider checks are typed. */
export type CatalogModel = CatalogShape["models"][number] & {
  /** Per mode, the params of which a run must carry at least one. */
  source_groups?: { mode: string; any_of: string[] }[];
  /** The longest prompt the model takes, where it states one. */
  max_input_chars?: number;
  [field: string]: unknown;
};

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
}

/**
 * The values of one param a reseller's request-body sample covers: each offered value the binding supports, a range's
 * two ends, each voice of its voice map; an empty list when any value it takes will do.
 * @param name - Our param.
 * @param param - The catalog's param.
 * @param binding - The binding.
 * @returns The values.
 */
export function coveredValues(name: string, param: OfferedParam | undefined, binding: MediaBinding): unknown[] {
  const voices = binding.voice_map?.[name];
  const values = voices !== undefined ? Object.keys(voices) : param?.values ?? (param?.min !== undefined && param.max !== undefined ? [param.min, param.max] : []);
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
