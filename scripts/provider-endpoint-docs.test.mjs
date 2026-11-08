// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

test("prices only the endpoints fal still serves: one whose document and price answer 404 is reported, and the next binding is still written", async () => {
  const list = [
    { model: "gone", binding: { model_id: "fal/gone" } },
    { model: "kept", binding: { model_id: "fal/kept", extra_steps: [{ endpoint: "fal/kept-step", pricing: {} }, { endpoint: "fal/free-step" }] } },
  ];
  const askedPrices = [];
  const docs = [];
  const written = [];
  const problems = await syncFalBindings(list, {
    fetchDoc: async (endpoint) => (endpoint === "fal/gone" ? undefined : { endpoint }),
    fetchPrice: async (endpoint) => {
      askedPrices.push(endpoint);
      return endpoint === "fal/gone" ? undefined : [{ endpoint_id: endpoint, unit_price: 0.1, unit: "seconds" }];
    },
    onDoc: async (entry, endpoint) => {
      docs.push(endpoint);
    },
    onPrice: (entry, endpoint, path, price) => {
      written.push([entry.model, endpoint, path, price.unit_price]);
    },
  });
  assert.deepEqual(problems, ["gone: fal no longer serves fal/gone"]);
  assert.deepEqual(askedPrices, ["fal/kept", "fal/kept-step"]);
  assert.deepEqual(docs, ["fal/kept", "fal/kept-step", "fal/free-step"]);
  assert.deepEqual(written, [["kept", "fal/kept", ["pricing"], 0.1], ["kept", "fal/kept-step", ["extra_steps", 0, "pricing"], 0.1]]);
});

test("reports a served endpoint fal states no price for, whether its pricing read answers 404 or lists other endpoints", async () => {
  const list = [{ model: "m", binding: { model_id: "fal/a", extra_steps: [{ endpoint: "fal/b", pricing: {} }] } }];
  const written = [];
  const problems = await syncFalBindings(list, {
    fetchDoc: async (endpoint) => ({ endpoint }),
    fetchPrice: async (endpoint) => (endpoint === "fal/a" ? undefined : [{ endpoint_id: "fal/other", unit_price: 1, unit: "images" }]),
    onDoc: () => undefined,
    onPrice: (entry, endpoint) => written.push(endpoint),
  });
  assert.deepEqual(problems, ["m: fal has no price for fal/a", "m: fal has no price for fal/b"]);
  assert.deepEqual(written, []);
});
