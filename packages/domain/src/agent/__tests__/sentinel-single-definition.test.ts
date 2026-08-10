// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Each interaction sentinel is spelled out in exactly one file: the tool that
 * produces it.
 *
 * A sentinel is a prefix a tool glues onto its return value so the agent loop
 * can tell "this result is a widget for the screen" from ordinary tool
 * output. Producer and reader therefore have to agree on the exact string,
 * and for a while both wrote it out — the server's parser held a second copy
 * of all four. Two spellings of one protocol is one edit away from a loop
 * that no longer recognises what a tool just returned, and the failure is
 * silent: the payload goes to the model as plain text and no widget appears.
 *
 * The scan covers the three packages that can hold agent code, because worker
 * runs the same loop. Tests are excluded — this file names all four to check
 * its own matcher, and the sentinel parser's unit test builds inputs out of
 * them.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";

const SCANNED_PKGS = ["domain", "server", "worker"];

/** Each sentinel's literal, and the one file allowed to spell it. */
const SENTINELS: ReadonlyArray<{ literal: string; owner: string }> = [
  { literal: "__ASK_USER__", owner: "packages/domain/src/agent/tools/ask-user.ts" },
  { literal: "__ASK_USER_CHOICE__", owner: "packages/domain/src/agent/tools/ask-user-choice.ts" },
  { literal: "__PROPOSE_CANVAS_ACTION__", owner: "packages/domain/src/agent/tools/propose-canvas-action.ts" },
  { literal: "__SHOW_SEARCH_RESULTS__", owner: "packages/domain/src/agent/tools/show-search-results.ts" },
];

/**
 * Whether a source spells a sentinel out.
 *
 * `__ASK_USER__` is a prefix of nothing, but `__ASK_USER_CHOICE__` contains
 * neither — the underscores make each literal self-delimiting, so a plain
 * substring test is exact here. Checked by the samples below.
 * @param source - The file's text.
 * @param literal - The sentinel string.
 * @returns True when the file writes that string out.
 */
function spells(source: string, literal: string): boolean {
  return source.includes(`"${literal}"`) || source.includes(`'${literal}'`);
}

/** Sources the matcher must catch, and sources it must leave alone. */
const SAMPLES: ReadonlyArray<{ source: string; literal: string; flagged: boolean; why: string }> = [
  { source: `export const ASK_USER_SENTINEL = "__ASK_USER__";`, literal: "__ASK_USER__", flagged: true, why: "a declaration" },
  { source: `if (s.startsWith('__ASK_USER__')) return;`, literal: "__ASK_USER__", flagged: true, why: "single quotes" },
  { source: `export const X = "__ASK_USER_CHOICE__";`, literal: "__ASK_USER__", flagged: false, why: "a longer sentinel is not the shorter one" },
  { source: `import { ASK_USER_SENTINEL } from "@breatic/domain";`, literal: "__ASK_USER__", flagged: false, why: "importing the name is the point" },
  { source: `// the __ASK_USER__ prefix marks a question`, literal: "__ASK_USER__", flagged: false, why: "prose about it, unquoted, is not a spelling" },
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

describe("interaction sentinels are spelled in one place", () => {
  it.each(SAMPLES)("matcher: $why", ({ source, literal, flagged }) => {
    expect(spells(source, literal)).toBe(flagged);
  });

  it.each(SENTINELS)("$literal is written only in its own tool", ({ literal, owner }) => {
    const ownerPath = join(MONOREPO_ROOT, owner);
    expect(spells(readFileSync(ownerPath, "utf-8"), literal), `${owner} no longer declares it`).toBe(true);

    const offenders: string[] = [];
    for (const pkg of SCANNED_PKGS) {
      for (const file of tsFiles(join(MONOREPO_ROOT, "packages", pkg, "src"))) {
        if (file === ownerPath) continue;
        if (spells(readFileSync(file, "utf-8"), literal)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
