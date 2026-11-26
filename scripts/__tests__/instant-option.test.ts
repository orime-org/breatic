// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstant } from "../instant-option.ts";

test("reads an instant with a zone", () => {
  assert.deepEqual(parseInstant("--at", "2026-11-20T10:00:00+08:00"), new Date("2026-11-20T02:00:00Z"));
  assert.deepEqual(parseInstant("--since", "2026-11-20T10:00:00.5Z"), new Date("2026-11-20T10:00:00.500Z"));
});

test("refuses a zone-less, unparseable or impossible instant and names the flag", () => {
  assert.throws(() => parseInstant("--at", "2026-11-20T10:00:00"), /--at/);
  assert.throws(() => parseInstant("--since", "yesterday"), /--since/);
  assert.throws(() => parseInstant("--at", "2026-13-40T10:00:00Z"), /--at/);
});
