// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The tracing switch `scripts/dev.mjs` hands `wrangler dev`.
 *
 * The miniflare wrangler pulls in records every span and log of a local run
 * under `.wrangler/state/v3/observability` and never deletes them; it reads
 * `X_LOCAL_OBSERVABILITY` (default on). The dev script turns it off unless the
 * caller already chose a value, which then passes through untouched.
 *
 * A stand-in `wrangler` on `PATH` prints what it was given, so the script runs
 * for real against a minimal `wrangler.toml` in a throwaway directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const DEV_SCRIPT = resolve(__dirname, "../dev.mjs");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-dev-"));
  // No [[containers]] and no [assets], so dev.mjs goes straight to wrangler.
  writeFileSync(join(dir, "wrangler.toml"), 'name = "ingest-dev-test"\nmain = "src/index.ts"\n');
  mkdirSync(join(dir, "bin"));
  const wrangler = join(dir, "bin", "wrangler");
  writeFileSync(wrangler, '#!/bin/sh\necho "X_LOCAL_OBSERVABILITY=${X_LOCAL_OBSERVABILITY-unset}"\nexit 0\n');
  chmodSync(wrangler, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the dev script in the temp directory and return the switch wrangler saw.
 *
 * @param callerValue - What the caller's environment sets, or undefined for nothing.
 * @returns The line the stand-in wrangler printed.
 */
function switchWranglerSees(callerValue: string | undefined): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.X_LOCAL_OBSERVABILITY;
  if (callerValue !== undefined) env.X_LOCAL_OBSERVABILITY = callerValue;
  env.PATH = [join(dir, "bin"), process.env.PATH ?? ""].join(delimiter);
  const run = spawnSync(process.execPath, [DEV_SCRIPT], { cwd: dir, env, encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

describe("the tracing switch the ingest dev script passes to wrangler", () => {
  it("turns local tracing off when the caller sets nothing", () => {
    expect(switchWranglerSees(undefined)).toBe("X_LOCAL_OBSERVABILITY=false");
  });

  it("passes the caller's own value through", () => {
    expect(switchWranglerSees("true")).toBe("X_LOCAL_OBSERVABILITY=true");
  });
});
