// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MediaBinding, ParamBinding } from "@provider/config/schema.js";
import type { MediaInput } from "@provider/media/runner.js";
import { isPresent } from "@provider/pricing/estimate.js";

/** A neutral reference the application writes into a prompt: `<<ref:{param}:{n}>>` (design 4.2). */
const REFERENCE = /<<ref:([\w-]+):(\d+)>>/g;

/**
 * One pronunciation entry as `text/pronunciation`, or undefined when either half is missing.
 * @param entry - One entry; untrusted collaborative data.
 * @returns The pair.
 */
function pronunciationPair(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { text, pronunciation } = entry as Record<string, unknown>;
  if (typeof text !== "string" || typeof pronunciation !== "string") return undefined;
  const [original, reading] = [text.trim(), pronunciation.trim()];
  return original !== "" && reading !== "" ? `${original}/${reading}` : undefined;
}

/**
 * One param's value as the upstream takes it.
 * @param bound - The param's binding.
 * @param value - Our value.
 * @returns The value to send, or undefined to send nothing.
 */
function written(bound: ParamBinding, value: unknown): unknown {
  if (bound.transform === "pronunciation_pairs") {
    const pairs = (Array.isArray(value) ? value : []).map(pronunciationPair).filter((p): p is string => p !== undefined);
    return pairs.length > 0 ? pairs : undefined;
  }
  if (!isPresent(value) || value === bound.absent_value) return undefined;
  const isChoice = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  const spelled = isChoice ? (bound.values?.[String(value)] ?? value) : value;
  return bound.item_key !== undefined && Array.isArray(spelled) ? spelled.map((item: unknown) => ({ [bound.item_key!]: item })) : spelled;
}

/**
 * The prompt with each neutral reference written the way this upstream names it.
 * @param binding - The binding.
 * @param prompt - Our prompt.
 * @returns The prompt to send.
 */
export function mentionsWritten(binding: MediaBinding, prompt: string): string {
  return prompt.replace(REFERENCE, (token, param: string, n: string) => {
    const template = binding.mentions?.[param];
    return template === undefined ? token : template.replaceAll("{n}", n).replaceAll("{i}", String(Number(n) - 1));
  });
}

/**
 * The body of a model's own call on WaveSpeed: each of our params under the
 * binding's field, its value spelled the upstream's way, an absent value and
 * an unbound param left out, and the prompt under `prompt_field` when there is one.
 * @param binding - The model's WaveSpeed binding.
 * @param input - Our prepared params and prompt.
 * @returns The body.
 */
export function buildBody(binding: MediaBinding, input: MediaInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [param, value] of Object.entries(input.params)) {
    const bound = binding.params?.[param];
    if (bound === undefined) continue;
    const out = written(bound, value);
    if (out !== undefined) body[bound.field] = out;
  }
  if (binding.prompt_field !== undefined && input.prompt !== "") body[binding.prompt_field] = mentionsWritten(binding, input.prompt);
  return body;
}
