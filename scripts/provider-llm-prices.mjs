// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How `scripts/provider-prices.ts` reads OpenRouter's token prices into `openrouter_prices` in
 * `config/provider/llm.yaml`, so a cheapest LLM call ranks OpenRouter beside the direct upstream
 * (inner#1743). A cheapest call asks OpenRouter to try its endpoints cheapest first (`provider.sort`
 * "price", within the model's levels: the quantizations `openrouter_quantizations` lists, `unknown` left out when one of
 * the model's endpoints states a level, which `openrouter_states_quantization` records apart from the prices, priced or
 * not), so the price written is that of the cheapest such endpoint OpenRouter lists for the model
 * (`GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints`). A service-tier endpoint (flex,
 * priority, fast) is reached only through `:floor`, `:nitro` or `service_tier`, never by `sort: "price"`
 * (OpenRouter's provider-selection docs), so it is not ranked. A model pinned to providers
 * (`openrouter_backends[model].only`) is ranked over their endpoints, the ones an understand call is held to; a
 * prepared call is not pinned, so it is priced at that or less.
 */

import { parseDocument } from "yaml";
import { yamlText } from "./provider-yaml.mjs";

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
 * quantization among the model's levels and, for a pinned model, a pinned provider, by input then output; and the
 * models one of whose listed endpoints states a level other than `unknown`, priced or not.
 * @param {ReadonlyMap<string, readonly { tag?: unknown; service_tier?: unknown; quantization?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[]>} endpoints - The endpoints OpenRouter lists, by OpenRouter's model id; a model it does not list is absent.
 * @param {ReadonlyMap<string, string>} ids - Our model id to the id OpenRouter lists it under.
 * @param {readonly string[]} quantizations - `openrouter_quantizations`, which `levels` narrows per model; an endpoint naming none is `unknown`.
 * @param {(quantizations: readonly string[], statesQuantization: boolean) => readonly string[]} levels - A model's levels, `openRouterLevels` of the provider's OpenRouter adapter.
 * @param {Readonly<Record<string, { only: readonly string[]; allow_fallbacks: boolean }>>} [backends] - `openrouter_backends` as llm.yaml writes it: by our model id, the providers it is pinned to.
 * @returns {{ prices: Record<string, { input_cache_miss_per_mtok: number; output_per_mtok: number }>; statesQuantization: string[]; problems: string[] }} The prices by our model id, the models that state a level in the order of `ids`, and a problem for each model given no price.
 */
export function openRouterPrices(endpoints, ids, quantizations, levels, backends = {}) {
  /** @type {Record<string, { input_cache_miss_per_mtok: number; output_per_mtok: number }>} */
  const prices = {};
  /** @type {string[]} */
  const statesQuantization = [];
  /** @type {string[]} */
  const problems = [];
  for (const [ours, theirs] of ids) {
    const listed = endpoints.get(theirs) ?? [];
    if (listed.length === 0) {
      problems.push(`${ours}: OpenRouter lists no endpoint of ${theirs}`);
      continue;
    }
    const states = listed.some((e) => typeof e.quantization === "string" && e.quantization !== "unknown");
    if (states) statesQuantization.push(ours);
    const taken = levels(quantizations, states);
    const fixed = listed
      .filter((e) => e.service_tier == null && pinnedTo(e.tag, backends[ours]?.only))
      .filter((e) => taken.includes(typeof e.quantization === "string" ? e.quantization : "unknown"))
      .map((e) => ({ input: perMtok(e.pricing?.prompt), output: perMtok(e.pricing?.completion) }))
      .filter((p) => p.input !== undefined && p.output !== undefined)
      .sort((a, b) => a.input - b.input || a.output - b.output);
    if (fixed.length === 0) {
      problems.push(`${ours}: none of the ${listed.length} endpoints of ${theirs} states a fixed token price at the standard tier, a quantization a cheapest call takes and a provider it is pinned to`);
      continue;
    }
    prices[ours] = { input_cache_miss_per_mtok: fixed[0].input, output_per_mtok: fixed[0].output };
  }
  return { prices, statesQuantization, problems };
}

/**
 * The direct prices whose off-peak holidays run out: a model whose price in effect at `now`, or one taking effect later,
 * has an off-peak discount whose holidays list no date in the current UTC year or after it, or, from 1 December, none
 * in the next year or after it, since the vendor's holidays are announced a year at a time, by the end of the year
 * before. The dates are written by hand in llm.yaml.
 * @param {Readonly<Record<string, readonly { from?: string; off_peak?: { holidays?: readonly string[] } }[]>>} prices - `prices` as llm.yaml writes it, by our model id.
 * @param {number} now - The run's moment, in epoch ms.
 * @returns {string[]} A problem for each such model.
 */
export function offPeakHolidayProblems(prices, now) {
  const today = new Date(now);
  const year = today.getUTCFullYear() + (today.getUTCMonth() === 11 ? 1 : 0);
  return Object.entries(prices)
    .filter(([, entries]) => entries
      .filter((e, i) => i + 1 === entries.length || Date.parse(entries[i + 1].from) > now)
      .some((e) => e.off_peak !== undefined && !(e.off_peak.holidays ?? []).some((d) => Number(d.slice(0, 4)) >= year)))
    .map(([model]) => `${model}: off-peak holidays list no date in ${year} (add them to its off_peak.holidays in config/provider/llm.yaml)`);
}

/**
 * The direct prices that change after OpenRouter's prices are read: a cheapest call ranks OpenRouter only against a
 * direct price that took effect before its prices were read, so from that change OpenRouter is unranked until the
 * sync runs again.
 * @param {Readonly<Record<string, readonly { from?: string }[]>>} prices - `prices` as llm.yaml writes it, by our model id.
 * @param {number} now - The run's moment, in epoch ms, when OpenRouter's prices are read.
 * @returns {string[]} A notice for each model whose direct price changes later, naming its next change.
 */
export function directPriceChangeNotices(prices, now) {
  return Object.entries(prices).flatMap(([model, entries]) => {
    const next = entries.find((e) => e.from !== undefined && Date.parse(e.from) > now);
    return next === undefined ? [] : [`${model}: its direct price changes at ${next.from}; rerun pnpm provider:prices after then so OpenRouter's price is read at the same time`];
  });
}

/**
 * `config/provider/llm.yaml` with `openrouter_prices` and `openrouter_states_quantization` rewritten in place (a key
 * the file lacks goes at its end) from OpenRouter's endpoints and `openrouter_prices_at` set to the run's moment, its
 * comments kept: for every model of its `prices`, in their order, read under `vendor_ids[model].openrouter` when
 * set, within the quantizations and backend pins the file's values hold once read through `parse`, the schema
 * createProvider reads it with (its defaults filled), each model's levels read through `levels`, as its calls read
 * them.
 * @param {string} text - The file as it is.
 * @param {(raw: unknown) => { prices: Record<string, readonly { from?: string; off_peak?: { holidays?: readonly string[] } }[]>; vendor_ids: Record<string, Record<string, string>>; openrouter_quantizations: readonly string[]; openrouter_backends: Record<string, { only: readonly string[]; allow_fallbacks: boolean }> }} parse - Reads the file's values as createProvider does.
 * @param {(quantizations: readonly string[], statesQuantization: boolean) => readonly string[]} levels - A model's levels, `openRouterLevels` of the provider's OpenRouter adapter.
 * @param {(id: string) => Promise<readonly object[] | undefined>} fetchEndpoints - OpenRouter's endpoints of one model by its id there; undefined when it lists none (404).
 * @param {number} [now] - The run's moment, in epoch ms: when OpenRouter's prices are read, and for `offPeakHolidayProblems` and `directPriceChangeNotices`.
 * @returns {Promise<{ text: string; priced: number; asked: number; problems: string[]; notices: string[] }>} The file's new text, how many models were priced of how many asked, a problem for each model given no price or whose off-peak holidays run out, and a notice for each model whose direct price changes later.
 * @throws {Error} When `parse` refuses the file, or a read fails other than with a 404.
 */
export async function syncedLlmYaml(text, parse, levels, fetchEndpoints, now = Date.now()) {
  const doc = parseDocument(text);
  const llm = parse(doc.toJS());
  const ids = new Map(Object.keys(llm.prices).map((model) => [model, llm.vendor_ids[model]?.openrouter ?? model]));
  const endpoints = new Map();
  for (const id of new Set(ids.values())) {
    const listed = await fetchEndpoints(id);
    if (listed !== undefined) endpoints.set(id, listed);
  }
  const { prices, statesQuantization, problems } = openRouterPrices(endpoints, ids, llm.openrouter_quantizations, levels, llm.openrouter_backends);
  doc.set("openrouter_prices", doc.createNode(prices));
  doc.set("openrouter_states_quantization", doc.createNode(statesQuantization));
  doc.set("openrouter_prices_at", new Date(now).toISOString());
  return {
    text: yamlText(doc, { lineWidth: 0 }),
    priced: Object.keys(prices).length,
    asked: ids.size,
    problems: [...problems, ...offPeakHolidayProblems(llm.prices, now)],
    notices: directPriceChangeNotices(llm.prices, now),
  };
}
