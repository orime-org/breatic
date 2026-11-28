// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What `scripts/dev.mjs` does before it starts `wrangler dev`: lay out the font set, refuse to start a Worker whose
 * `wrangler.toml` lacks `[assets]` (inner#1709 design §5.3), and the tracing switch it hands wrangler.
 *
 * The font set is static assets the Timeline preview reads whether or not web animation is on, so `[assets]` is
 * required and the font set is laid out on every start. The script finds the font script beside itself, not in the
 * working directory.
 *
 * The miniflare wrangler pulls in records every span and log of a local run
 * under `.wrangler/state/v3/observability` and never deletes them; it reads
 * `X_LOCAL_OBSERVABILITY` (default on). The dev script turns it off unless the
 * caller already chose a value, which then passes through untouched.
 *
 * A stand-in `wrangler` on `PATH` prints what it was given, so the script runs
 * for real against a minimal `wrangler.toml` in a throwaway directory that has
 * no `scripts/` of its own.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const DEV_SCRIPT = resolve(__dirname, "../dev.mjs");

/** A `wrangler.toml` with no `[[containers]]`, so web animation is off. */
const WITHOUT_ASSETS = 'name = "ingest-dev-test"\nmain = "src/index.ts"\n';

/** The same with the font set's static assets, the configuration every copy needs. */
const WITH_ASSETS = `${WITHOUT_ASSETS}\n[assets]\ndirectory = "./assets"\n`;

/** What the stand-in wrangler prints first, so a run can tell whether wrangler started. */
const WRANGLER_LINE = /^X_LOCAL_OBSERVABILITY=/;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-dev-"));
  writeFileSync(join(dir, "wrangler.toml"), WITH_ASSETS);
  mkdirSync(join(dir, "bin"));
  const wrangler = join(dir, "bin", "wrangler");
  writeFileSync(wrangler, '#!/bin/sh\necho "X_LOCAL_OBSERVABILITY=${X_LOCAL_OBSERVABILITY-unset}"\nexit 0\n');
  chmodSync(wrangler, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the dev script in the temp directory.
 *
 * @param callerValue - What the caller's environment sets for the tracing switch, or undefined for nothing.
 * @returns The lines it printed to stdout, trimmed.
 */
function runDev(callerValue?: string): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.X_LOCAL_OBSERVABILITY;
  if (callerValue !== undefined) env.X_LOCAL_OBSERVABILITY = callerValue;
  env.PATH = [join(dir, "bin"), process.env.PATH ?? ""].join(delimiter);
  const run = spawnSync(process.execPath, [DEV_SCRIPT], { cwd: dir, env, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.split("\n").map((line) => line.trim());
}

/**
 * Run the dev script and return the switch wrangler saw.
 *
 * @param callerValue - What the caller's environment sets, or undefined for nothing.
 * @returns The line the stand-in wrangler printed, or undefined when wrangler never started.
 */
function switchWranglerSees(callerValue: string | undefined): string | undefined {
  return runDev(callerValue).find((line) => WRANGLER_LINE.test(line));
}

describe("the tracing switch the ingest dev script passes to wrangler", () => {
  it("turns local tracing off when the caller sets nothing", () => {
    expect(switchWranglerSees(undefined)).toBe("X_LOCAL_OBSERVABILITY=false");
  }, 300_000);

  it("passes the caller's own value through", () => {
    expect(switchWranglerSees("true")).toBe("X_LOCAL_OBSERVABILITY=true");
  }, 300_000);
});

describe("the font set the ingest dev script lays out", () => {
  it("lays it out before starting wrangler with web animation off, finding the font script beside itself rather than in the working directory", () => {
    const lines = runDev();
    const fonts = lines.findIndex((line) => /^web-animation font set v\d+: \d+ faces in /.test(line));
    const wrangler = lines.findIndex((line) => WRANGLER_LINE.test(line));
    expect(fonts, lines.join("\n")).toBeGreaterThanOrEqual(0);
    expect(wrangler, lines.join("\n")).toBeGreaterThan(fonts);
  }, 300_000);

  it("does not start wrangler when wrangler.toml has no [assets], and prints the two lines to add", () => {
    writeFileSync(join(dir, "wrangler.toml"), WITHOUT_ASSETS);
    const lines = runDev();
    expect(lines.filter((line) => WRANGLER_LINE.test(line))).toEqual([]);
    const assets = lines.indexOf("[assets]");
    expect(assets, lines.join("\n")).toBeGreaterThanOrEqual(0);
    expect(lines[assets + 1]).toBe('directory = "./assets"');
  }, 300_000);
});
