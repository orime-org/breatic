// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActivityCoverageOptions } from "../activity-coverage-options.ts";

for (const action of ["open", "close"] as const) {
  test(`P22 parses explicit ${action}, version and operator`, () => {
    assert.deepEqual(parseActivityCoverageOptions([action, "--version", "1", "--operator", "noc-operator"]), {
      help: false, action, version: 1, operator: "noc-operator",
    });
  });
}

test("P22 permits help without application configuration or a mutation", () => {
  assert.deepEqual(parseActivityCoverageOptions(["--help"]), { help: true });
});

for (const args of [[], ["open"], ["open", "--version", "1"], ["close", "--operator", "noc-operator"]]) {
  test(`P22 rejects missing required maintenance arguments ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseActivityCoverageOptions(args));
  });
}

for (const version of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
  test(`P22 rejects invalid coverage version ${version}`, () => {
    assert.throws(() => parseActivityCoverageOptions(["open", "--version", version, "--operator", "noc-operator"]));
  });
}

test("P22 rejects unknown commands before any application mutation", () => {
  assert.throws(() => parseActivityCoverageOptions(["restart", "--version", "1", "--operator", "noc-operator"]));
});

test("P22 rejects a browser or operator supplied confirmation time", () => {
  assert.throws(() => parseActivityCoverageOptions(["open", "--version", "1", "--operator", "noc-operator", "--at", "2026-01-01T00:00:00Z"]));
});

for (const option of ["--version", "--operator"]) {
  test(`P22 rejects ambiguous duplicate ${option} flags`, () => {
    assert.throws(() => parseActivityCoverageOptions(["open", "--version", "1", "--operator", "noc-operator", option, option === "--version" ? "2" : "other-operator"]));
  });
}
