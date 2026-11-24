// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequeueOptions, pickRequeue } from "../commerce-requeue-dead-letters-options.ts";

const A = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const B = "7a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d";

test("takes one or more dead-letter ids, reporting unless told to apply", () => {
  assert.deepEqual(parseRequeueOptions(["--id", A]), { help: false, apply: false, again: false, selection: { ids: [A] } });
  assert.deepEqual(parseRequeueOptions(["--id", A, "--apply", "--id", B]), { help: false, apply: true, again: false, selection: { ids: [A, B] } });
});

test("takes a reason and the instant to look back to", () => {
  assert.deepEqual(parseRequeueOptions(["--since", "2026-11-20T10:00:00+08:00", "--reason", "attempts_exhausted", "--apply"]), {
    help: false,
    apply: true,
    again: false,
    selection: { reason: "attempts_exhausted", since: new Date("2026-11-20T02:00:00Z") },
  });
});

test("takes --again with ids only", () => {
  assert.deepEqual(parseRequeueOptions(["--id", A, "--again", "--apply"]), { help: false, apply: true, again: true, selection: { ids: [A] } });
  assert.throws(() => parseRequeueOptions(["--reason", "refused", "--since", "2026-11-20T10:00:00Z", "--again"]));
});

test("answers help", () => {
  assert.deepEqual(parseRequeueOptions(["--help"]), { help: true });
});

test("refuses nothing selected, both ways mixed, half a reason selection, bad values and unknown arguments", () => {
  assert.throws(() => parseRequeueOptions([]));
  assert.throws(() => parseRequeueOptions(["--apply"]));
  assert.throws(() => parseRequeueOptions(["--id", A, "--reason", "refused", "--since", "2026-11-20T10:00:00Z"]));
  assert.throws(() => parseRequeueOptions(["--reason", "refused"]));
  assert.throws(() => parseRequeueOptions(["--since", "2026-11-20T10:00:00Z"]));
  assert.throws(() => parseRequeueOptions(["--reason", "refused", "--since", "2026-11-20 10:00"]));
  assert.throws(() => parseRequeueOptions(["--reason", "refused", "--reason", "x", "--since", "2026-11-20T10:00:00Z"]));
  assert.throws(() => parseRequeueOptions(["--id", "not-a-uuid"]));
  assert.throws(() => parseRequeueOptions(["--id"]));
  assert.throws(() => parseRequeueOptions(["--id", A, "--force"]));
});

const WHEN = new Date("2026-11-21T00:00:00Z");

test("a reason selection skips the dead letters already requeued", () => {
  const fresh = { id: A, requeuedAt: null };
  const done = { id: B, requeuedAt: WHEN };
  assert.deepEqual(pickRequeue({ reason: "refused", since: WHEN }, [fresh, done], false), { requeue: [fresh], skipped: [done] });
});

test("an id selection requeues an already requeued dead letter only when told --again", () => {
  const fresh = { id: A, requeuedAt: null };
  const done = { id: B, requeuedAt: WHEN };
  assert.throws(() => pickRequeue({ ids: [A, B] }, [fresh, done], false), /already requeued at 2026-11-21T00:00:00.000Z; pass --again/);
  assert.deepEqual(pickRequeue({ ids: [A, B] }, [fresh, done], true), { requeue: [fresh, done], skipped: [] });
});
