// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Freezes what today's code answers, so the provider package can prove it
 * answers the same without importing today's code (inner#1743, design 13.2).
 *
 * Run from the repository root with `pnpm exec tsx scripts/provider-fixtures.ts`.
 * It reads every catalog model's WaveSpeed pricing contracts, prices a set of
 * upstream field values per contract with shared's `upstreamPriceUsd`, and
 * writes the cases to `packages/provider/test/fixtures/upstream-price.json`.
 * The provider package reads that file only. This script imports code that the
 * migration deletes, so it lives outside the package and is removed with it.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { upstreamPriceUsd } from "../packages/shared/src/pricing/upstream-price.js";

interface RawPricing { base_price: number; formula: string; discount_rate: number }
interface RawParam { upstream?: string; default?: unknown; values?: unknown[]; type?: string }
interface RawModel {
  name: string;
  takes_prompt?: boolean;
  prompt_upstream?: string;
  params?: Record<string, RawParam>;
  providers?: { name: string; pricing: RawPricing }[];
  extra_steps?: { kind?: string; pricing: RawPricing }[];
}

/** One frozen case: a contract, the fields it was evaluated on, and what today's code answered. */
interface PriceCase {
  model: string;
  /** Key into the file's `contracts`. */
  contract: string;
  fields: Record<string, unknown>;
  durations: Record<string, number[]>;
  usd: number | null;
}

/** A contract in the evaluator's shape. */
interface Contract { basePrice: number; formula: string; discountRate: number }

const ROOT = resolve(import.meta.dirname, "..");
const MODALITIES = ["image", "video", "audio", "tts"];
const PROMPTS = ["", "a red fox running through fresh snow at dawn"];
const CLIP_SECONDS = [[5], [12], [3, 9]];

/**
 * Today's pricing contract in the evaluator's shape.
 * @param raw - The contract as the catalog writes it.
 * @returns The contract.
 */
function contractOf(raw: RawPricing): Contract {
  return { basePrice: raw.base_price, formula: raw.formula, discountRate: raw.discount_rate };
}

/**
 * The field values a model sends with every param at its default.
 * @param model - The catalog entry.
 * @returns Upstream field name to value.
 */
function defaults(model: RawModel): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    fields[spec.upstream ?? name] = spec.default ?? (spec.type === "list" ? [] : null);
  }
  return fields;
}

/**
 * Every field set to price: the defaults, then each offered value of each param in turn,
 * with prompt and clip-length samples only where the formula reads them.
 * @param model - The catalog entry.
 * @param formula - The contract's formula.
 * @returns The field sets and clip lengths.
 */
function samples(model: RawModel, formula: string): { fields: Record<string, unknown>; durations: Record<string, number[]> }[] {
  const base = defaults(model);
  const variants: Record<string, unknown>[] = [base];
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    for (const value of spec.values ?? []) variants.push({ ...base, [spec.upstream ?? name]: value });
  }
  const promptField = model.prompt_upstream ?? "prompt";
  const listFields = Object.entries(model.params ?? {}).map(([name, spec]) => spec.upstream ?? name);
  const out: { fields: Record<string, unknown>; durations: Record<string, number[]> }[] = [];
  for (const variant of variants) {
    const prompts = model.takes_prompt === false ? [""] : formula.includes("$length") ? PROMPTS : [PROMPTS[1]!];
    for (const prompt of prompts) {
      for (const clips of formula.includes("get_duration") ? CLIP_SECONDS : [[5]]) {
        const durations = Object.fromEntries(listFields.map((field) => [field, clips]));
        out.push({ fields: { ...variant, ...(model.takes_prompt === false ? {} : { [promptField]: prompt }) }, durations });
      }
    }
  }
  return out;
}

/**
 * Price one field set with today's evaluator; a formula that refuses the input is recorded as null.
 * @param pricing - The contract.
 * @param fields - The field values.
 * @param durations - Clip lengths per field.
 * @returns USD, or null when today's code throws.
 */
async function priceOrNull(pricing: Contract, fields: Record<string, unknown>, durations: Record<string, number[]>): Promise<number | null> {
  try {
    return await upstreamPriceUsd(pricing, fields, durations);
  } catch {
    return null;
  }
}

const cases: PriceCase[] = [];
const contracts: Record<string, Contract> = {};
for (const modality of MODALITIES) {
  const file = parse(readFileSync(resolve(ROOT, `config/models/${modality}/models.yaml`), "utf8")) as { models: RawModel[] };
  for (const model of file.models) {
    const contracts: [string, RawPricing][] = [
      ...(model.providers ?? []).map((p): [string, RawPricing] => [`model:${p.name}`, p.pricing]),
      ...(model.extra_steps ?? []).map((s, i): [string, RawPricing] => [`step:${i}:${s.kind ?? "step"}`, s.pricing]),
    ];
    for (const [contract, raw] of contracts) {
      const pricing = contractOf(raw);
      const id = `${model.name}#${contract}`;
      contracts[id] = pricing;
      const seen = new Set<string>();
      for (const { fields, durations } of samples(model, pricing.formula)) {
        const key = JSON.stringify([fields, durations]);
        if (seen.has(key)) continue;
        seen.add(key);
        cases.push({ model: model.name, contract: id, fields, durations, usd: await priceOrNull(pricing, fields, durations) });
      }
    }
  }
}

const out = resolve(ROOT, "packages/provider/test/fixtures/upstream-price.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ contracts, cases })}\n`);
process.stdout.write(`${cases.length} cases, ${cases.filter((c) => c.usd === null).length} refused, written to ${out}\n`);
