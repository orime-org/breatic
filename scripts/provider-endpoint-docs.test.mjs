// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { servedDocuments } from "./provider-endpoint-docs.mjs";

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
