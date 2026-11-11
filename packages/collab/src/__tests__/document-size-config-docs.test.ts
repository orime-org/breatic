// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size cap's entries in `config/collab.yaml` say what they do
 * and match the code (inner#1790 doc-sync checks D-01, D-02).
 *
 * The YAML is what an operator reads to tune the cap. A key without a comment
 * leaves them guessing; a file value that differs from the loader's default
 * means the file and the code disagree about what "default" is; and the old
 * comment saying the cap is only logged would tell them the opposite of what
 * collab now does.
 */
import type * as FsModule from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const YAML_PATH = resolve(import.meta.dirname, "../../../../config/collab.yaml");

/** The second version's four document_size_* keys and the defaults the design fixes for them. */
const DEFAULTS: ReadonlyArray<readonly [string, number]> = [
  ["document_size_warn_ratio", 0.9],
  ["document_size_delete_headroom_bytes", 262144],
  ["document_size_max_delete_splits", 1024],
  ["document_size_measure_interval_ms", 2000],
];

/**
 * The loader's answer for an empty YAML mapping, i.e. its own defaults.
 * @returns The parsed config.
 */
async function loaderDefaults(): Promise<Record<string, unknown>> {
  vi.resetModules();
  vi.doMock("node:fs", async (orig) => ({
    ...(await orig<typeof FsModule>()),
    readFileSync: () => "{}\n",
  }));
  try {
    const mod = await import("../config.js");
    return mod.getCollabConfig();
  } finally {
    vi.doUnmock("node:fs");
  }
}

describe("collab.yaml document size keys (D-01)", () => {
  const text = readFileSync(YAML_PATH, "utf-8");
  const lines = text.split("\n");
  const parsed = parse(text) as Record<string, unknown>;

  it.each(DEFAULTS)("declares %s with a comment line right above it", (key) => {
    const index = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
    expect(index, `${key} is in collab.yaml`).toBeGreaterThan(0);
    expect(lines[index - 1]?.trimStart().startsWith("#"), `${key} has a comment above`).toBe(true);
  });

  it.each(DEFAULTS)("ships %s at %s in the file", (key, value) => {
    expect(parsed[key]).toBe(value);
  });

  it("has the loader default every file value", async () => {
    const defaults = await loaderDefaults();
    // Against the literal as well: with the key missing on both sides the
    // file-versus-loader comparison alone would pass as undefined === undefined.
    for (const [key, value] of DEFAULTS) {
      expect(defaults[key], key).toBe(value);
      expect(defaults[key], key).toBe(parsed[key]);
    }
  });
});

describe("collab.yaml max_document_bytes comment (D-02)", () => {
  const text = readFileSync(YAML_PATH, "utf-8");

  it("no longer says the cap is only logged", () => {
    expect(text).not.toContain("only logged (warn)");
    expect(text).not.toContain("updates are not refused");
  });
});
