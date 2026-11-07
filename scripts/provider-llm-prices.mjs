// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How `scripts/provider-prices.ts` reads OpenRouter's token prices into `openrouter_prices` in
 * `config/provider/llm.yaml`, so a cheapest LLM call ranks OpenRouter beside the direct upstream
 * (inner#1743). A cheapest call asks OpenRouter to try its endpoints cheapest first (`provider.sort`
 * "price", within the quantizations `openrouter_quantizations` lists), so the price written is that of
 * the cheapest such endpoint OpenRouter lists for the model
 * (`GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints`). A service-tier endpoint (flex,
 * priority, fast) is reached only through `:floor`, `:nitro` or `service_tier`, never by `sort: "price"`
 * (OpenRouter's provider-selection docs), so it is not ranked. A model pinned to providers
 * (`openrouter_backends[model].only`) is ranked over their endpoints, the ones an understand call is held to; a
 * prepared call is not pinned, so it is priced at that or less.
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
 * Whether an endpoint is served by one of the providers a model is pinned to: its tag is the provider or
 * begins with `provider/`.
 * @param {unknown} tag - The endpoint's tag.
 * @param {readonly string[] | undefined} only - The providers the model is pinned to; undefined when it is not.
 * @returns {boolean} True when the endpoint can serve the model's call.
 */
function pinnedTo(tag, only) {
  return only === undefined || (typeof tag === "string" && only.some((p) => tag === p || tag.startsWith(`${p}/`)));
}

/**
 * Our models' OpenRouter token prices: per model, its cheapest standard-tier endpoint with a fixed price, a
 * quantization a cheapest call takes and, for a pinned model, a pinned provider, by input then output.
 * @param {ReadonlyMap<string, readonly { tag?: unknown; service_tier?: unknown; quantization?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[]>} endpoints - The endpoints OpenRouter lists, by OpenRouter's model id; a model it does not list is absent.
 * @param {ReadonlyMap<string, string>} ids - Our model id to the id OpenRouter lists it under.
 * @param {readonly string[]} quantizations - The quantizations a cheapest call takes; an endpoint naming none is `unknown`.
 * @param {Readonly<Record<string, { only: readonly string[]; allow_fallbacks: boolean }>>} [backends] - `openrouter_backends` as llm.yaml writes it: by our model id, the providers it is pinned to.
 * @returns {{ prices: Record<string, { input_cache_miss_per_mtok: number; output_per_mtok: number }>; problems: string[] }} The prices by our model id, and a problem for each model given no price.
 */
export function openRouterPrices(endpoints, ids, quantizations, backends = {}) {
  /** @type {Record<string, { input_cache_miss_per_mtok: number; output_per_mtok: number }>} */
  const prices = {};
  /** @type {string[]} */
  const problems = [];
  for (const [ours, theirs] of ids) {
    const listed = endpoints.get(theirs) ?? [];
    if (listed.length === 0) {
      problems.push(`${ours}: OpenRouter lists no endpoint of ${theirs}`);
      continue;
    }
    const fixed = listed
      .filter((e) => e.service_tier == null && pinnedTo(e.tag, backends[ours]?.only))
      .filter((e) => quantizations.includes(typeof e.quantization === "string" ? e.quantization : "unknown"))
      .map((e) => ({ input: perMtok(e.pricing?.prompt), output: perMtok(e.pricing?.completion) }))
      .filter((p) => p.input !== undefined && p.output !== undefined)
      .sort((a, b) => a.input - b.input || a.output - b.output);
    if (fixed.length === 0) {
      problems.push(`${ours}: none of the ${listed.length} endpoints of ${theirs} states a fixed token price at the standard tier, a quantization a cheapest call takes and a provider it is pinned to`);
      continue;
    }
    prices[ours] = { input_cache_miss_per_mtok: fixed[0].input, output_per_mtok: fixed[0].output };
  }
  return { prices, problems };
}
