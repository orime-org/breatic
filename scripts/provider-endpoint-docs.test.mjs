// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { servedDocuments, syncFalBindings } from "./provider-endpoint-docs.mjs";

test("reads every endpoint an upstream still serves, and names each one it answers 404 for", async () => {
  const asked = [];
  const fetchDoc = async (endpoint) => {
    asked.push(endpoint);
    return endpoint === "gone/one" ? undefined : { paths: endpoint };
  };
  const { served, problems } = await servedDocuments("m", ["first/one", "gone/one", "last/one"], fetchDoc, "fal no longer serves");
  assert.deepEqual(asked, ["first/one", "gone/one", "last/one"]);
  assert.deepEqual(served, [["first/one", { paths: "first/one" }], ["last/one", { paths: "last/one" }]]);
  assert.deepEqual(problems, ["m: fal no longer serves gone/one"]);
});

test("lets any other failure of a read through", async () => {
  const fetchDoc = async () => {
    throw new Error("GET x answered 500");
  };
  await assert.rejects(servedDocuments("m", ["a"], fetchDoc, "SandBase no longer lists"), /answered 500/);
});

/** Where the fake fal serves an endpoint's document and its prices. */
const docUrl = (endpoint) => `https://docs.example/${endpoint}`;
const priceUrl = (endpoint) => `https://prices.example/${endpoint}`;

/**
 * The script's `json` reader over a fake fal: a URL in `answers` is answered with its value, one in `failing` with that
 * status, and any other answers 404, which, as the real reader does, throws unless `absentOn404` is set.
 * @param {Record<string, unknown>} answers - The 2xx answers, by URL.
 * @param {Record<string, number>} [failing] - Other statuses, by URL.
 * @param {string[]} [asked] - Collects every URL read with the headers it was sent.
 * @returns {(url: string, init?: { headers?: Record<string, string> }, options?: { absentOn404?: boolean }) => Promise<unknown>} The reader.
 */
const fakeFal = (answers, failing = {}, asked = []) => async (url, init = {}, { absentOn404 = false } = {}) => {
  asked.push(`${url} ${JSON.stringify(init.headers ?? {})}`);
  if (url in answers) return answers[url];
  const status = failing[url] ?? 404;
  if (status === 404 && absentOn404) return undefined;
  throw new Error(`GET ${url} answered ${status}`);
};

/** fal's pricing answer for one endpoint. */
const priced = (endpoint, unit_price = 0.1) => ({ prices: [{ endpoint_id: endpoint, unit_price, unit: "seconds" }] });

test("prices only the endpoints fal still serves: one whose document answers 404 is reported, and the next binding is still written", async () => {
  const list = [
    { model: "gone", binding: { model_id: "fal/gone" } },
    { model: "kept", binding: { model_id: "fal/kept", extra_steps: [{ endpoint: "fal/kept-step", pricing: {} }, { endpoint: "fal/free-step" }] } },
  ];
  const asked = [];
  const docs = [];
  const written = [];
  const json = fakeFal({
    [docUrl("fal/kept")]: { endpoint: "fal/kept" },
    [docUrl("fal/kept-step")]: { endpoint: "fal/kept-step" },
    [docUrl("fal/free-step")]: { endpoint: "fal/free-step" },
    [priceUrl("fal/kept")]: priced("fal/kept"),
    [priceUrl("fal/kept-step")]: priced("fal/kept-step"),
    [priceUrl("fal/gone")]: priced("fal/gone"),
  }, {}, asked);
  const problems = await syncFalBindings(list, {
    json,
    docUrl,
    priceUrl,
    priceHeaders: { Authorization: "Key k" },
    onDoc: async (entry, endpoint) => {
      docs.push(endpoint);
    },
    onPrice: (entry, endpoint, path, price) => {
      written.push([entry.model, endpoint, path, price.unit_price]);
    },
  });
  assert.deepEqual(problems, ["gone: fal no longer serves fal/gone"]);
  assert.deepEqual(asked.filter((a) => a.startsWith("https://prices.example/")), [
    'https://prices.example/fal/kept {"Authorization":"Key k"}',
    'https://prices.example/fal/kept-step {"Authorization":"Key k"}',
  ]);
  assert.deepEqual(docs, ["fal/kept", "fal/kept-step", "fal/free-step"]);
  assert.deepEqual(written, [["kept", "fal/kept", ["pricing"], 0.1], ["kept", "fal/kept-step", ["extra_steps", 0, "pricing"], 0.1]]);
});

test("reports a served endpoint fal states no price for, whether its pricing read answers 404 or lists other endpoints, and still writes the next binding", async () => {
  const list = [
    { model: "m", binding: { model_id: "fal/a", extra_steps: [{ endpoint: "fal/b", pricing: {} }] } },
    { model: "next", binding: { model_id: "fal/c" } },
  ];
  const written = [];
  const json = fakeFal({
    [docUrl("fal/a")]: {},
    [docUrl("fal/b")]: {},
    [docUrl("fal/c")]: {},
    [priceUrl("fal/b")]: priced("fal/other", 1),
    [priceUrl("fal/c")]: priced("fal/c"),
  });
  const problems = await syncFalBindings(list, { json, docUrl, priceUrl, priceHeaders: {}, onDoc: () => undefined, onPrice: (entry, endpoint) => written.push(endpoint) });
  assert.deepEqual(problems, ["m: fal has no price for fal/a", "m: fal has no price for fal/b"]);
  assert.deepEqual(written, ["fal/c"]);
});

test("lets a price read that fails other than with a 404 through", async () => {
  const list = [{ model: "m", binding: { model_id: "fal/a" } }];
  const json = fakeFal({ [docUrl("fal/a")]: {} }, { [priceUrl("fal/a")]: 500 });
  await assert.rejects(syncFalBindings(list, { json, docUrl, priceUrl, priceHeaders: {}, onDoc: () => undefined, onPrice: () => undefined }), /answered 500/);
});
