// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSnapshotLine, parseTierSnapshotOptions, writeSnapshotFile } from "../tier-snapshot-options.ts";

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

const ROW = { userId: "u1", effectiveTier: "base", limits: null, settlementProtected: false };

/**
 * Rows as the reader yields them, failing after `failAfter` rows when given.
 * @param count - How many rows.
 * @param failAfter - Throw after this many, or never.
 * @yields The rows.
 */
async function* rows(count: number, failAfter?: number): AsyncGenerator<typeof ROW> {
  for (let i = 0; i < count; i += 1) {
    if (i === failAfter) throw new Error("connection lost");
    yield { ...ROW, userId: `u${i}` };
  }
}

test("writes every row and answers how many", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "snap-")), "out.jsonl");
  assert.equal(await writeSnapshotFile(rows(3), path), 3);
  assert.equal(readFileSync(path, "utf-8").split("\n").filter(Boolean).length, 3);
});

test("removes the file it was writing when the read fails, so a rerun can use the name", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "snap-")), "out.jsonl");
  await assert.rejects(writeSnapshotFile(rows(5, 2), path), /connection lost/);
  assert.equal(existsSync(path), false);
  assert.equal(await writeSnapshotFile(rows(1), path), 1);
});

test("never overwrites or removes a snapshot already there", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "snap-")), "out.jsonl");
  writeFileSync(path, "finished\n");
  await assert.rejects(writeSnapshotFile(rows(1), path), /EEXIST/);
  assert.equal(readFileSync(path, "utf-8"), "finished\n");
});

test("still removes the file when closing it fails after a failed read", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "snap-")), "out.jsonl");
  let closes = 0;
  const openFailingClose: typeof open = async (...args) => {
    const handle = await open(...args);
    const realClose = handle.close.bind(handle);
    handle.close = async (): Promise<void> => {
      closes += 1;
      await realClose();
      throw new Error("close failed");
    };
    return handle;
  };
  await assert.rejects(writeSnapshotFile(rows(5, 2), path, openFailingClose), /close failed|connection lost/);
  assert.equal(closes, 1);
  assert.equal(existsSync(path), false);
});
