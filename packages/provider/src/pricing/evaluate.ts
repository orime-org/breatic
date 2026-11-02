// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import jsonata from "jsonata";

const MICRO_USD_PER_USD = 1_000_000;

// WaveSpeed writes `get_duration(field)` and `get_duration(field, min=a, max=b,
// total=c)` without the `$` JSONata needs and with keyword arguments that parse
// as comparisons; both become a registered function called with the field name.
const GET_DURATION = /get_duration\(\s*(\w+)\s*(?:,\s*min=([\d.]+)\s*,\s*max=([\d.]+)\s*,\s*total=([\d.]+)\s*)?\)/g;

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
 * Compile one expression in WaveSpeed's formula dialect, `get_duration` registered over the clip lengths.
 * @param formula - The expression.
 * @param durations - Clip lengths in seconds, keyed by upstream field.
 * @returns The compiled expression.
 * @throws {Error} When the expression is not valid JSONata.
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
  return expression;
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
    const message = (error as { message?: unknown } | undefined)?.message;
    return typeof message === "string" ? message : String(error);
  }
}

/**
 * Whether a condition in the formula dialect holds for one request.
 * @param condition - The JSONata condition.
 * @param fields - The request in the upstream's field names.
 * @param durations - Clip lengths in seconds, keyed by upstream field, for `get_duration`.
 * @returns True only when it evaluates to true.
 * @throws {Error} When the condition is not valid JSONata or fails to evaluate.
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
 * @throws {Error} When the formula does not produce a finite `total_price`.
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
