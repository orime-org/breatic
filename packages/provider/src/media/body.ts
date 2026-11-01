// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MediaBinding, ParamBinding } from "@provider/config/schema.js";

/** How a written value is converted: to a string, a number, or a one-item list. */
type Conversion = ParamBinding["as"];
import type { MediaInput } from "@provider/media/runner.js";
import { isPresent } from "@provider/pricing/estimate.js";

/** A neutral reference the application writes into a prompt: `<<ref:{param}:{n}>>`. */
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
 * A value converted as the binding asks.
 * @param value - The spelled value.
 * @param as - The conversion, if any.
 * @returns The converted value.
 */
function converted(value: unknown, as: Conversion): unknown {
  if (as === "string") return String(value);
  if (as === "number") return Number(value);
  if (as === "list") return [value];
  return value;
}

/**
 * One item of a list param with its sub-fields renamed, spelled and converted; sub-fields the binding does not name are left out.
 * @param item - One item; untrusted collaborative data.
 * @param fields - The binding's sub-field mapping.
 * @returns The item to send.
 */
function itemWritten(item: unknown, fields: NonNullable<ParamBinding["item_fields"]>): Record<string, unknown> {
  const source = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [sub, bound] of Object.entries(fields)) {
    const value = source[sub];
    if (value === null || value === undefined) continue;
    const spelled = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? (bound.values?.[String(value)] ?? value) : value;
    out[bound.field] = converted(spelled, bound.as);
  }
  return out;
}

/**
 * Write a value at a dotted path, creating and merging the objects on the way.
 * @param body - The body being built.
 * @param path - The field, dots separating nested objects.
 * @param value - The value.
 */
function writeAt(body: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let at = body;
  for (const key of keys.slice(0, -1)) {
    const next = at[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  at[keys[keys.length - 1]!] = value;
}

/**
 * One param's value as the upstream takes it.
 * @param bound - The param's binding.
 * @param value - Our value.
 * @param sendEmpty - Whether "" and [] are sent, only null and absent left out.
 * @returns The value to send, or undefined to send nothing.
 */
function written(bound: ParamBinding, value: unknown, sendEmpty: boolean): unknown {
  if (bound.transform === "pronunciation_pairs") {
    const pairs = (Array.isArray(value) ? value : []).map(pronunciationPair).filter((p): p is string => p !== undefined);
    return pairs.length > 0 ? pairs : undefined;
  }
  if (value === null || value === undefined || (!sendEmpty && !isPresent(value)) || value === bound.absent_value) return undefined;
  if (bound.item_fields !== undefined && Array.isArray(value)) return value.map((item: unknown) => itemWritten(item, bound.item_fields!));
  const isChoice = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  const spelled = converted(isChoice ? (bound.values?.[String(value)] ?? value) : value, bound.as);
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
 * The body of a model's own call: each of our params under the binding's field
 * (dots writing nested objects), its value spelled and converted the upstream's
 * way, an absent value and an unbound param left out, the prompt under
 * `prompt_field` when there is one (empty values and an empty prompt only when
 * the binding sets `send_empty`), and the binding's fixed fields.
 * @param binding - The model's binding.
 * @param input - Our prepared params and prompt.
 * @returns The body.
 */
export function buildBody(binding: MediaBinding, input: MediaInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [param, value] of Object.entries(input.params)) {
    const bound = binding.params?.[param];
    if (bound === undefined) continue;
    const voices = binding.voice_map?.[param];
    const out = written(bound, voices !== undefined && typeof value === "string" ? (voices[value] ?? value) : value, binding.send_empty === true);
    if (out !== undefined) writeAt(body, bound.field, out);
  }
  if (binding.prompt_field !== undefined && (input.prompt !== "" || binding.send_empty === true)) body[binding.prompt_field] = mentionsWritten(binding, input.prompt);
  return { ...body, ...binding.fixed };
}
