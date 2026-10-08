// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { outcomeOf, sizeCorrection } from "./backfill-previews-plan.mjs";

test("writes back a size the read measured the other way round", () => {
  assert.deepEqual(
    sizeCorrection({ width: 400, height: 200 }, { width: 200, height: 400 }),
    { width: 200, height: 400 },
  );
});

test("fills a size the row never had", () => {
  assert.deepEqual(
    sizeCorrection({ width: null, height: null }, { width: 800, height: 450 }),
    { width: 800, height: 450 },
  );
});

test("leaves a row whose size already matches", () => {
  assert.equal(
    sizeCorrection({ width: 800, height: 450 }, { width: 800, height: 450 }),
    null,
  );
});

test("leaves a row alone when the read measured nothing", () => {
  assert.equal(
    sizeCorrection({ width: 800, height: 450 }, { width: null, height: null }),
    null,
  );
});

test("counts a read that threw as failed", () => {
  assert.equal(outcomeOf(null, new Error("socket hang up")), "failed");
});

test("counts a read the Worker answered 404 as missing", () => {
  assert.equal(outcomeOf(null, Object.assign(new Error("gone"), { status: 404 })), "missing");
});

test("counts a read that threw with another status as failed", () => {
  assert.equal(outcomeOf(null, Object.assign(new Error("busy"), { status: 503 })), "failed");
});

test("counts each outcome the Worker names", () => {
  for (const outcome of ["generated", "existing", "none", "failed"]) {
    assert.equal(outcomeOf({ preview: outcome }), outcome);
  }
});

test("counts whatever outcome the Worker names", () => {
  assert.equal(outcomeOf({ preview: "timeout" }), "timeout");
});

test("counts a read that named no outcome as failed", () => {
  assert.equal(outcomeOf({}), "failed");
});
