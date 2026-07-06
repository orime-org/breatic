// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";

/**
 * Invariant guard (#1625 Slice 3): every LLM call must route through the
 * model-call wrapper (generateTextRetry / streamTextRetry) so the retry budget
 * is set in one place. No source file may value-import `generateText` /
 * `streamText` directly from the "ai" SDK — except the wrapper itself. A future
 * call site that imports the SDK directly would silently inherit the SDK
 * default retry budget; this test fails loudly instead.
 */
const SCANNED_PKGS = ["domain", "server", "worker"];
const WRAPPER = join(
  MONOREPO_ROOT,
  "packages/domain/src/agent/model-call.ts",
);
// A VALUE import of generateText/streamText from "ai" (not `import type`).
const BARE_IMPORT =
  /import\s+\{[^}]*\b(generateText|streamText)\b[^}]*\}\s+from\s+["']ai["']/;

/** Recursively collect non-test .ts files under a directory. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("LLM calls route through the model-call wrapper (#1625)", () => {
  it("no source value-imports generateText/streamText from 'ai' except the wrapper", () => {
    const offenders: string[] = [];
    for (const pkg of SCANNED_PKGS) {
      const root = join(MONOREPO_ROOT, "packages", pkg, "src");
      for (const file of tsFiles(root)) {
        if (file === WRAPPER) continue;
        if (BARE_IMPORT.test(readFileSync(file, "utf-8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
