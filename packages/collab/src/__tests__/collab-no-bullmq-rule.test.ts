// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * collab never opens a queue (inner#2043). Core's factories refuse once
 * `forbidQueues()` ran; the dependency-cruiser rule `collab-no-bullmq` closes
 * the other way, a collab module building a BullMQ object itself. This runs the
 * repository's own rule set over a sample collab module that imports `bullmq`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cruise, type ICruiseResult, type IConfiguration } from "dependency-cruiser";

const REPO_ROOT = resolve(__dirname, "../../../..");
const config = createRequire(import.meta.url)(join(REPO_ROOT, ".dependency-cruiser.cjs")) as IConfiguration;

let base = "";

/**
 * Cruise one sample file under a temporary repository layout with the repo's rule set.
 * @param relPath - Where the sample sits, relative to the temporary root.
 * @param source - The sample's source.
 * @returns The names of the rules it breaks.
 */
async function violationsOf(relPath: string, source: string): Promise<string[]> {
  const file = join(base, relPath);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, source);
  const result = await cruise([relPath], {
    baseDir: base,
    validate: true,
    ruleSet: { forbidden: config.forbidden ?? [] },
    tsPreCompilationDeps: true,
  });
  const output = result.output as ICruiseResult;
  return output.summary.violations.map((v) => v.rule.name);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "collab-no-bullmq-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("collab-no-bullmq", () => {
  it("reports a collab module that imports bullmq", async () => {
    const names = await violationsOf(
      "packages/collab/src/services/opens-queue.ts",
      'import { Queue } from "bullmq";\nexport const q = new Queue("x");\n',
    );
    expect(names).toContain("collab-no-bullmq");
  });

  it("leaves a worker module that imports bullmq alone", async () => {
    const names = await violationsOf(
      "packages/worker/src/handlers/opens-queue.ts",
      'import { Queue } from "bullmq";\nexport const q = new Queue("x");\n',
    );
    expect(names).not.toContain("collab-no-bullmq");
  });
});
