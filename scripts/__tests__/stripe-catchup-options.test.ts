// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStripeCatchUpOptions } from "../stripe-catchup-options.ts";

test("takes the moment processing stopped", () => {
  assert.deepEqual(parseStripeCatchUpOptions(["--since", "2026-11-20T10:00:00Z"]), {
    help: false,
    since: new Date("2026-11-20T10:00:00Z"),
  });
});

test("answers help", () => {
  assert.deepEqual(parseStripeCatchUpOptions(["--help"]), { help: true });
});

test("refuses a missing, unparseable, zone-less or extra argument", () => {
  assert.throws(() => parseStripeCatchUpOptions([]));
  assert.throws(() => parseStripeCatchUpOptions(["--since", "yesterday"]));
  assert.throws(() => parseStripeCatchUpOptions(["--since", "2026-11-20T10:00:00"]));
  assert.throws(() => parseStripeCatchUpOptions(["--since", "2026-11-20T10:00:00Z", "--extra"]));
});
