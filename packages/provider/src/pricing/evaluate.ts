// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import jsonata from "jsonata";

const MICRO_USD_PER_USD = 1_000_000;

// WaveSpeed writes `get_duration(field)` and `get_duration(field, min=a, max=b,
// total=c)` without the `$` JSONata needs and with keyword arguments that parse
// as comparisons; both become a registered function called with the field name.
const GET_DURATION = /get_duration\(\s*(\w+)\s*(?:,\s*min=([\d.]+)\s*,\s*max=([\d.]+)\s*,\s*total=([\d.]+)\s*)?\)/g;

/**
 * The characters `\w` stands for in the upstreams' validators (pydantic's Rust regex, where it is Unicode):
 * letters and other alphabetic characters, combining marks, decimal digits, connector punctuation and the
 * joiners. Written for a character class compiled with the `u` flag.
 */
export const WORD_CLASS = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}";

/** A whole string of word characters. */
const WORD = new RegExp(`^[${WORD_CLASS}]+$`, "u");

/**
 * Whether a value is a non-empty string of word characters, as the upstreams read `^\w+$`; any other value is not.
 * @param value - The value; untrusted collaborative data.
 * @returns True only for such a string.
 */
function isWord(value: unknown): boolean {
  return typeof value === "string" && WORD.test(value);
}

/**
 * One upstream contract: `basePrice` in millionths of a USD, a JSONata `formula`
 * (empty means a flat `basePrice` per call), `discountRate` the percentage of the
 * price charged (100 is full price).
 */
export interface PriceContract {
  readonly basePrice: number;
  readonly formula: string;
  readonly discountRate: number;
}

/**
 * Compile one expression in WaveSpeed's formula dialect, `get_duration` registered over the clip lengths
 * and `$word` (whether a value is a string of word characters) beside it.
 * @param formula - The expression.
 * @param durations - Clip lengths in seconds, keyed by upstream field.
 * @returns The compiled expression.
 * @throws {jsonata.JsonataError} When the expression is not valid JSONata (a plain object, not an Error instance).
 */
function compiled(formula: string, durations: Readonly<Record<string, readonly number[]>>): jsonata.Expression {
  const expression = jsonata(formula.replace(
    GET_DURATION,
    (_all, field: string, min?: string, max?: string, total?: string) =>
      min === undefined ? `$get_duration("${field}")` : `$get_duration("${field}", ${min}, ${max}, ${total})`,
  ));
  expression.registerFunction(
    "get_duration",
    (field: string, min?: number, max?: number, total?: number) => {
      const sum = (durations[field] ?? []).reduce((acc, clip) => acc + Math.min(max ?? Infinity, Math.max(min ?? 0, clip)), 0);
      return Math.min(total ?? Infinity, sum);
    },
    "<sn?n?n?:n>",
  );
  expression.registerFunction("word", isWord, "<x?:b>");
  return expression;
}

/**
 * The words of what JSONata threw, which is a plain object rather than an Error.
 * @param error - What it threw.
 * @returns Its message, or the value as text.
 */
export function evaluationMessage(error: unknown): string {
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : String(error);
}

/**
 * Why an expression in the formula dialect does not compile.
 * @param formula - The expression.
 * @returns The parser's message, or undefined when it compiles.
 */
export function formulaProblem(formula: string): string | undefined {
  try {
    compiled(formula, {});
    return undefined;
  } catch (error) {
    return evaluationMessage(error);
  }
}

/**
 * Whether a condition in the formula dialect holds for one request.
 * @param condition - The JSONata condition.
 * @param fields - The request in the upstream's field names.
 * @param durations - Clip lengths in seconds, keyed by upstream field, for `get_duration`.
 * @returns True only when it evaluates to true.
 * @throws {jsonata.JsonataError} When the condition is not valid JSONata or fails to evaluate (a plain object, not an Error instance).
 */
export async function holds(
  condition: string,
  fields: Readonly<Record<string, unknown>>,
  durations: Readonly<Record<string, readonly number[]>>,
): Promise<boolean> {
  return (await compiled(condition, durations).evaluate({ ...fields })) === true;
}

/**
 * Price one request on one contract.
 * @param contract - The contract.
 * @param fields - The request in the upstream's field names.
 * @param durations - Clip lengths in seconds, keyed by upstream field, for `get_duration`.
 * @returns USD after the discount.
 * @throws {jsonata.JsonataError} When the formula is not valid JSONata or fails to evaluate (a plain object, not an Error instance).
 * @throws {Error} When the formula gives no finite `total_price` (a run that leaves out a field the formula multiplies by gets this).
 */
export async function priceUsd(
  contract: PriceContract,
  fields: Readonly<Record<string, unknown>>,
  durations: Readonly<Record<string, readonly number[]>>,
): Promise<number> {
  const discount = contract.discountRate / 100;
  if (contract.formula.trim() === "") return (contract.basePrice / MICRO_USD_PER_USD) * discount;
  const result: unknown = await compiled(contract.formula, durations).evaluate({ ...fields, base_price: contract.basePrice });
  const total = (result as { total_price?: unknown } | undefined)?.total_price;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new Error(`Pricing formula produced no finite total_price: ${contract.formula}`);
  }
  return (total / MICRO_USD_PER_USD) * discount;
}
