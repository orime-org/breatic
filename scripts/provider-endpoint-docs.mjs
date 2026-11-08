// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How `scripts/provider-prices.ts` reads each bound endpoint's document from fal and SandBase (inner#1743): an
 * endpoint the upstream no longer serves answers 404, which is listed as a problem while the sync reads the rest;
 * fal's prices are asked only for the endpoints it still serves.
 */

/**
 * The documents of one model's endpoints that its upstream still serves, in order, and a problem for each it answers
 * 404 for.
 * @param {string} model - Our model, for the problem.
 * @param {readonly string[]} endpoints - Its endpoints on the upstream.
 * @param {(endpoint: string) => Promise<unknown>} fetchDoc - Reads one endpoint's document; undefined when the upstream answers 404.
 * @param {string} gone - What the problem says before an endpoint answered 404, such as "fal no longer serves".
 * @returns {Promise<{ served: [string, unknown][]; problems: string[] }>} Each served endpoint with its document, and the problems.
 * @throws {Error} When a read fails other than with a 404.
 */
export async function servedDocuments(model, endpoints, fetchDoc, gone) {
  /** @type {[string, unknown][]} */
  const served = [];
  /** @type {string[]} */
  const problems = [];
  for (const endpoint of endpoints) {
    const doc = await fetchDoc(endpoint);
    if (doc === undefined) problems.push(`${model}: ${gone} ${endpoint}`);
    else served.push([endpoint, doc]);
  }
  return { served, problems };
}

/**
 * Sync fal's bindings one after another: each endpoint's document, then the price of each priced endpoint fal still
 * serves (the binding's own and each extra step with a `pricing`). Both reads take a 404 as "absent": an endpoint fal
 * answers 404 for, or states no price for, is a problem, and the next binding is read all the same.
 * @template {{ model: string; binding: { model_id: string; extra_steps?: readonly { endpoint: string; pricing?: unknown }[] } }} E
 * @param {readonly E[]} list - The fal bindings, each with its model.
 * @param {object} io - How the sync reads fal and writes what it read.
 * @param {(url: string, init: { headers?: Record<string, string> }, options: { absentOn404: boolean }) => Promise<unknown>} io.json - The script's reader: one answer as JSON, undefined on a 404 when `absentOn404` is set, and it throws on any other failure.
 * @param {(endpoint: string) => string} io.docUrl - Where fal serves one endpoint's OpenAPI document.
 * @param {(endpoint: string) => string} io.priceUrl - Where fal states one endpoint's prices.
 * @param {Record<string, string>} io.priceHeaders - The headers a price read is sent with (fal's key).
 * @param {(entry: E, endpoint: string, doc: unknown) => unknown} io.onDoc - Writes one served endpoint's document.
 * @param {(entry: E, endpoint: string, path: (string | number)[], price: { endpoint_id: string; unit_price: number; unit: string }) => unknown} io.onPrice - Writes one endpoint's price at its path in the binding.
 * @returns {Promise<string[]>} The problems.
 * @throws {Error} When a read fails other than with a 404.
 */
export async function syncFalBindings(list, { json, docUrl, priceUrl, priceHeaders, onDoc, onPrice }) {
  /** @type {string[]} */
  const problems = [];
  for (const entry of list) {
    const { model, binding } = entry;
    const steps = binding.extra_steps ?? [];
    const read = await servedDocuments(model, [binding.model_id, ...steps.map((s) => s.endpoint)], (endpoint) => json(docUrl(endpoint), {}, { absentOn404: true }), "fal no longer serves");
    problems.push(...read.problems);
    for (const [endpoint, doc] of read.served) await onDoc(entry, endpoint, doc);
    const served = new Set(read.served.map(([endpoint]) => endpoint));
    /** @type {[string, (string | number)[]][]} */
    const priced = [[binding.model_id, ["pricing"]], ...steps.flatMap((s, i) => (s.pricing === undefined ? [] : [[s.endpoint, ["extra_steps", i, "pricing"]]]))];
    for (const [endpoint, path] of priced) {
      if (!served.has(endpoint)) continue;
      // A served endpoint whose price read answers 404 has no price, like one fal's answer leaves out.
      const answer = /** @type {{ prices?: readonly { endpoint_id: string; unit_price: number; unit: string }[] } | undefined} */ (await json(priceUrl(endpoint), { headers: priceHeaders }, { absentOn404: true }));
      const price = answer?.prices?.find((p) => p.endpoint_id === endpoint);
      if (price === undefined) problems.push(`${model}: fal has no price for ${endpoint}`);
      else await onPrice(entry, endpoint, path, price);
    }
  }
  return problems;
}
