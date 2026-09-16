// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every running line a tool declares has a string in every language.
 *
 * The line a reader watches while a tool runs is named by a key the tool
 * carries. A key with a typo, or one added to English alone, reaches the
 * chat column as itself -- and nothing else in the build looks at it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";
import { MONOREPO_ROOT } from "@breatic/core";

import { TOOL_MAP } from "@domain/agent/tools/index.js";

/**
 * The running-line key a tool declares, if it declares one.
 * @param canvasTool - The tool to read.
 * @returns Its key, or undefined.
 */
function runningLineOf(canvasTool: unknown): string | undefined {
  const metadata = (canvasTool as { metadata?: { runningLine?: string } }).metadata;
  return metadata?.runningLine;
}

/**
 * One locale catalog, parsed.
 * @param file - The catalog's file name.
 * @returns Its whole tree.
 */
function localeCatalog(file: string): Record<string, unknown> {
  const path = resolve(MONOREPO_ROOT, "locales", file);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Follow a dotted key through a catalog.
 * @param tree - The catalog to walk.
 * @param key - The dotted key.
 * @returns The string it names, or undefined.
 */
function lookup(tree: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      tree,
    );
}

describe("a tool's running line", () => {
  it("names a string every locale carries", () => {
    const declared = Object.values(TOOL_MAP)
      .map((build) => runningLineOf(build()))
      .filter((key): key is string => key !== undefined);
    expect(declared.length, "some tool declares a running line").toBeGreaterThan(0);

    const locales = readdirSync(resolve(MONOREPO_ROOT, "locales")).filter((file) =>
      file.endsWith(".json"),
    );
    expect(locales.length, "the product ships several languages").toBeGreaterThan(1);

    for (const file of locales) {
      const tree = localeCatalog(file);
      for (const key of declared) {
        expect(typeof lookup(tree, key), `${file} carries ${key}`).toBe("string");
      }
    }
  });
});
