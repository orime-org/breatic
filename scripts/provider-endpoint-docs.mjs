// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How `scripts/provider-prices.ts` reads each bound endpoint's document from fal and SandBase (inner#1743): an
 * endpoint the upstream no longer serves answers 404, which is listed as a problem while the sync reads the rest.
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
