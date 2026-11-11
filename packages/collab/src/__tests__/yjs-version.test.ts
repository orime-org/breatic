// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size bound is derived from how yjs 13.6.33 encodes and grows a
 * document (inner#1790, design 4.1 and 9; spec C-135). Another yjs version may
 * add a growth path the bound does not cover, so the resolved version is pinned
 * here and changing it means reviewing that table first.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The version of the yjs this package resolves at run time.
 * @returns The `version` field of yjs's own package.json.
 * @throws {Error} When no package.json is found above the resolved entry.
 */
function resolvedYjsVersion(): string {
  let dir = dirname(realpathSync(createRequire(import.meta.url).resolve("yjs")));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "yjs") return pkg.version ?? "";
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no yjs package.json above the resolved entry");
    dir = parent;
  }
}

describe("yjs version", () => {
  it("C-135 is the version the document size bound was reviewed against", () => {
    expect(
      resolvedYjsVersion(),
      "review the yjs size-changing path table in docs/ARCHITECTURE.md#space-document-size-cap before changing this version",
    ).toBe("13.6.33");
  });
});
