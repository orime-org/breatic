// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every LLM call goes through the model-call wrapper, so the retry budget is
 * decided in one place. No source file may value-import an SDK entry point
 * that starts a model run — only `model-call.ts` may.
 *
 * The list is every such entry point the SDK exports, not just the two we use
 * today. That is deliberate: PR-2 considered adding wrappers for
 * `generateObject` and the agent class and decided not to, because nothing
 * calls them — which leaves this guard as the only thing standing between a
 * future call site and a silently different retry budget. A guard that only
 * knows about today's call sites would wave that call site straight through.
 *
 * Two blind spots the earlier version had, both closed here:
 *
 * A namespace import (`import * as ai from "ai"`) reaches every one of these
 * without naming any of them, so it is refused outright.
 *
 * And the matcher itself was never checked. A regex that stops matching
 * reports a clean repo forever — the same way `lint:no-cjk` passed CJK into
 * main on 2026-07-14. So the matcher is run against planted samples first,
 * and if it has gone blind the samples go red before the scan reports green.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";

const SCANNED_PKGS = ["domain", "server", "worker"];
const WRAPPER = join(MONOREPO_ROOT, "packages/domain/src/agent/model-call.ts");

/**
 * The SDK exports that start a model run, verbatim from ai@6.0.141's export
 * list. `Experimental_Agent` is an alias of `ToolLoopAgent`; both are named
 * because either spelling imports the same class.
 */
const RUN_STARTERS = [
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
  "Agent",
  "ToolLoopAgent",
  "Experimental_Agent",
];

/** A value import (not `import type`) of any run-starter from "ai". */
const NAMED_IMPORT = new RegExp(
  String.raw`import\s+\{[^}]*\b(${RUN_STARTERS.join("|")})\b[^}]*\}\s+from\s+["']ai["']`,
);

/** Any namespace import from "ai" — it reaches all of the above unnamed. */
const NAMESPACE_IMPORT = /import\s+\*\s+as\s+\w+\s+from\s+["']ai["']/;

/**
 * Whether a source file imports a way to start a model run directly.
 * @param source - The file's text.
 * @returns True when the file bypasses the wrapper.
 */
function bypassesWrapper(source: string): boolean {
  return NAMED_IMPORT.test(source) || NAMESPACE_IMPORT.test(source);
}

/** Sources the matcher must catch, and sources it must leave alone. */
const SAMPLES: ReadonlyArray<{ source: string; flagged: boolean; why: string }> = [
  { source: `import { generateText } from "ai";`, flagged: true, why: "the original case" },
  { source: `import { streamText } from 'ai';`, flagged: true, why: "single quotes" },
  { source: `import { generateObject } from "ai";`, flagged: true, why: "structured output" },
  { source: `import { streamObject } from "ai";`, flagged: true, why: "streaming structured output" },
  { source: `import { Experimental_Agent } from "ai";`, flagged: true, why: "the agent class, aliased name" },
  { source: `import { ToolLoopAgent } from "ai";`, flagged: true, why: "the agent class, real name" },
  { source: `import { Agent } from "ai";`, flagged: true, why: "the other agent class" },
  { source: `import { tool, generateText } from "ai";`, flagged: true, why: "hidden among allowed names" },
  { source: `import * as ai from "ai";`, flagged: true, why: "namespace import reaches all of them" },
  { source: `import type { GenerateTextResult } from "ai";`, flagged: false, why: "types cost nothing at runtime" },
  { source: `import { tool, stepCountIs } from "ai";`, flagged: false, why: "helpers that start no run" },
  { source: `import { generateText } from "./local-generate-text.js";`, flagged: false, why: "same name, not the SDK" },
];

/**
 * Recursively collect non-test .ts files under a directory.
 * @param dir - Directory to walk.
 * @returns Absolute paths of every non-test TypeScript file beneath it.
 */
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

describe("LLM calls route through the model-call wrapper", () => {
  it.each(SAMPLES)("matcher: $why", ({ source, flagged }) => {
    expect(bypassesWrapper(source)).toBe(flagged);
  });

  it("no source imports a way to start a model run except the wrapper", () => {
    const offenders: string[] = [];
    for (const pkg of SCANNED_PKGS) {
      const root = join(MONOREPO_ROOT, "packages", pkg, "src");
      for (const file of tsFiles(root)) {
        if (file === WRAPPER) continue;
        if (bypassesWrapper(readFileSync(file, "utf-8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
