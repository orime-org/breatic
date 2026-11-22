// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A partner build shows the partner's name everywhere the client names
 * itself (#1599, design §9.1.1). The client's own code and pages therefore
 * never write the official product name or its scheme: they read the brand
 * the build was made for. Only the workspace package scope, the two bridge
 * names the pages call, the build's environment variable names and the
 * splash's "powered by" attribution are allowed.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");
const ALLOWED = [/@breatic\//g, /\bbreaticDesktop\b/g, /\bbreaticConnect\b/g, /\bBREATIC_[A-Z_]+\b/g, /^const ATTRIBUTION = "Breatic";$/gm];

/**
 * Every source file under a directory, tests left out.
 * @param dir - The directory.
 * @returns The files' paths.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.(ts|html|css)$/.test(name) ? [path] : [];
  });
}

describe("client sources", () => {
  it("never name the official product or its scheme", () => {
    const offenders = sources(SRC).flatMap((file) => {
      const text = ALLOWED.reduce((rest, pattern) => rest.replace(pattern, ""), readFileSync(file, "utf8"));
      return text
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /breatic/i.test(line))
        .map(({ line, index }) => `${relative(SRC, file)}:${index + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
