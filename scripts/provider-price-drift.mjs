// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How `scripts/provider-prices.ts` treats a price fact a binding's formula was written from by
 * hand (SandBase's `price_formula`, fal's billing `unit`): stored the first time it is seen, and
 * when it later changes, reported and left as stored, so it is reported until a reviewer rewrites
 * the formula and the stored fact with it (inner#1775).
 */

/**
 * Compare a stored price fact with the one the upstream states now, by their JSON.
 * @param {unknown} stored - The stored fact, or undefined when none is stored yet.
 * @param {unknown} live - The fact the upstream states now.
 * @param {string} label - What the fact is, for the problem: model, endpoint, upstream and the fact's name.
 * @returns {{ store: boolean; problem: string | undefined }} Whether to store the live fact, and the problem to report when it changed.
 */
export function priceFactDrift(stored, live, label) {
  if (stored === undefined) return { store: true, problem: undefined };
  if (JSON.stringify(stored) === JSON.stringify(live)) return { store: false, problem: undefined };
  return { store: false, problem: `${label} changed, rewrite the binding's pricing and the stored fact: ${JSON.stringify(stored)} -> ${JSON.stringify(live)}` };
}

/**
 * The price WaveSpeed states it charges in a `/model/price` answer: `data.discounted_price`, a number or a numeric string.
 * @param {unknown} answer - The answer.
 * @returns {number | string} The price in USD, or why the answer states none, starting `no discounted_price (`.
 */
export function statedPrice(answer) {
  const data = typeof answer === "object" && answer !== null && "data" in answer ? answer.data : undefined;
  const price = typeof data === "object" && data !== null ? data.discounted_price : undefined;
  // An answer without a price is a difference to look at, not a match.
  const usd = typeof price === "number" || (typeof price === "string" && price.trim() !== "") ? Number(price) : Number.NaN;
  return Number.isFinite(usd) ? usd : `no discounted_price (${String(JSON.stringify(data ?? answer)).slice(0, 120)})`;
}

/**
 * What WaveSpeed's charges for the 3D samples decide: the content of `three-d-prices.json`, by model id in fixture
 * order, or none when any sample went unpriced (the fixture is then left as it is, so no sample's check is lost to a
 * failed price call), and the problems: each unpriced sample, and each charge our formula does not match.
 * @param {readonly { id: string; model: string; inputs: Record<string, unknown>; usd: number | string; local: number }[]} samples - Each sample: its WaveSpeed model id, our model, its inputs, WaveSpeed's charge (or why there is none) and our formula's price.
 * @param {readonly string[]} order - The 3D model ids in the fixture's order.
 * @returns {{ charged: Record<string, { inputs: Record<string, unknown>; usd: number }[]> | undefined; problems: string[] }} The fixture's content or none, and the problems.
 */
export function threeDSampleCheck(samples, order) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, { inputs: Record<string, unknown>; usd: number }[]>} */
  const charged = new Map();
  let unpriced = false;
  for (const { id, model, inputs, usd, local } of samples) {
    const line = `${model} ${JSON.stringify(inputs)}: WaveSpeed ${usd}, local ${local}`;
    if (typeof usd !== "number") {
      unpriced = true;
      problems.push(`three-d-prices.json not rewritten: ${line}`);
      continue;
    }
    if (Math.abs(usd - local) > 1e-9) problems.push(`price mismatch: ${line}`);
    charged.set(id, [...(charged.get(id) ?? []), { inputs, usd }]);
  }
  return { charged: unpriced ? undefined : Object.fromEntries(order.flatMap((id) => (charged.has(id) ? [[id, charged.get(id)]] : []))), problems };
}
