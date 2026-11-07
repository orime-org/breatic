// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How `scripts/provider-prices.ts` reads OpenRouter's token prices from its model list
 * (`GET https://openrouter.ai/api/v1/models`) into `openrouter_prices` in `config/provider/llm.yaml`,
 * so a cheapest LLM call ranks OpenRouter beside the direct upstream (inner#1743).
 */

/**
 * One per-token price OpenRouter states, as USD per million tokens.
 * @param {unknown} perToken - The stated price: USD per token, as a string.
 * @returns {number | undefined} The price per million tokens without float noise, or undefined when it is missing, not a number or negative ("-1" is no fixed price).
 */
function perMtok(perToken) {
  if (typeof perToken !== "string" || perToken.trim() === "") return undefined;
  const usd = Number(perToken);
  if (!Number.isFinite(usd) || usd < 0) return undefined;
  return Number((usd * 1_000_000).toPrecision(12));
}

/**
 * Our models' OpenRouter token prices, from OpenRouter's model list.
 * @param {readonly { id: string; pricing?: { prompt?: unknown; completion?: unknown } }[]} listed - The `data` array of OpenRouter's model list.
 * @param {ReadonlyMap<string, string>} ids - Our model id to the id OpenRouter lists it under.
 * @returns {{ prices: Record<string, { input_cache_miss_per_mtok: number; output_per_mtok: number }>; problems: string[] }} The prices by our model id, and a problem for each model given no price.
 */
export function openRouterPrices(listed, ids) {
  const byId = new Map(listed.map((m) => [m.id, m]));
  /** @type {Record<string, { input_cache_miss_per_mtok: number; output_per_mtok: number }>} */
  const prices = {};
  /** @type {string[]} */
  const problems = [];
  for (const [ours, theirs] of ids) {
    const model = byId.get(theirs);
    if (model === undefined) {
      problems.push(`${ours}: OpenRouter lists no model ${theirs}`);
      continue;
    }
    const input = perMtok(model.pricing?.prompt);
    const output = perMtok(model.pricing?.completion);
    if (input === undefined || output === undefined) {
      problems.push(`${ours}: OpenRouter states no fixed token price for ${theirs} (prompt ${JSON.stringify(model.pricing?.prompt)}, completion ${JSON.stringify(model.pricing?.completion)})`);
      continue;
    }
    prices[ours] = { input_cache_miss_per_mtok: input, output_per_mtok: output };
  }
  return { prices, problems };
}
