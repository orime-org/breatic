// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSnapshotLine, parseTierSnapshotOptions } from "../tier-snapshot-options.ts";

test("takes the moment to read at and a new output file", () => {
  assert.deepEqual(parseTierSnapshotOptions(["--at", "2026-11-20T10:00:00Z", "--output", "/tmp/before.jsonl"]), {
    help: false,
    at: new Date("2026-11-20T10:00:00Z"),
    outputPath: "/tmp/before.jsonl",
  });
  assert.deepEqual(parseTierSnapshotOptions(["--output", "o.jsonl", "--at", "2026-11-20T10:00:00+08:00"]), {
    help: false,
    at: new Date("2026-11-20T02:00:00Z"),
    outputPath: "o.jsonl",
  });
});

test("answers help", () => {
  assert.deepEqual(parseTierSnapshotOptions(["--help"]), { help: true });
});

test("refuses missing, repeated, zone-less or unknown arguments", () => {
  assert.throws(() => parseTierSnapshotOptions([]));
  assert.throws(() => parseTierSnapshotOptions(["--at", "2026-11-20T10:00:00Z"]));
  assert.throws(() => parseTierSnapshotOptions(["--at", "2026-11-20T10:00:00", "--output", "o"]));
  assert.throws(() => parseTierSnapshotOptions(["--at", "2026-11-20T10:00:00Z", "--at", "2026-11-20T10:00:00Z", "--output", "o"]));
  assert.throws(() => parseTierSnapshotOptions(["--at", "2026-11-20T10:00:00Z", "--output", "o", "--extra", "x"]));
});

test("writes one line in a fixed field and key order, so two snapshots compare byte by byte", () => {
  const a = formatSnapshotLine({
    settlementProtected: false,
    limits: { storage_bytes: 5, team_studios: 1, studio_members: 2, projects_per_studio: 3, project_members: 4, concurrent_editors: 6 },
    effectiveTier: "pro",
    userId: "u1",
  });
  const b = formatSnapshotLine({
    userId: "u1",
    effectiveTier: "pro",
    limits: { team_studios: 1, projects_per_studio: 3, concurrent_editors: 6, studio_members: 2, project_members: 4, storage_bytes: 5 },
    settlementProtected: false,
  });
  assert.equal(a, b);
  assert.equal(
    a,
    '{"userId":"u1","effectiveTier":"pro","limits":{"concurrent_editors":6,"project_members":4,"projects_per_studio":3,"storage_bytes":5,"studio_members":2,"team_studios":1},"settlementProtected":false}\n',
  );
  assert.equal(
    formatSnapshotLine({ userId: "u2", effectiveTier: "enterprise", limits: null, settlementProtected: true }),
    '{"userId":"u2","effectiveTier":"enterprise","limits":null,"settlementProtected":true}\n',
  );
});
