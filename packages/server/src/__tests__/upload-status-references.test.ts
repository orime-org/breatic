// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The upload status route is removed together with everything that used it (#1580, test spec L-06; design §4):
 * a page learns how its upload ended from the `upload:ended` message (Project) or the Studio page poll, and the
 * smoke helpers wait for what the page shows. Nothing under `packages/` names the route any more.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = path.join(import.meta.dirname, "..", "..", "..");
const ROUTE = "/assets/upload-status";

/** Files allowed to name the route: this scan, and L-01, which asks for it to see it is gone. */
const ALLOWED = new Set([
  path.join("server", "src", "__tests__", "upload-status-references.test.ts"),
  path.join("server", "src", "__tests__", "routes", "assets.test.ts"),
]);

/**
 * Every source, test and smoke file under `dir`.
 * @param dir - Where to start.
 * @returns Their paths relative to `packages/`.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx|mts|js|mjs|json|yaml)$/.test(name) ? [path.relative(PACKAGES, full)] : [];
  });
}

describe("the upload status route", () => {
  it("L-06 is named nowhere under packages/", () => {
    const naming = files(PACKAGES)
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => readFileSync(path.join(PACKAGES, file), "utf8").includes(ROUTE));
    expect(naming).toEqual([]);
  });
});
