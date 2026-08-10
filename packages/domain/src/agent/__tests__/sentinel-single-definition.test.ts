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
 * Strip comments, so that writing about a sentinel is not writing one.
 *
 * Same approach the repo's brand-token check takes: judge the code, not the
 * prose around it. Crude by design — it does not know a `//` inside a string
 * from a real line comment — which can only ever make this guard stricter
 * about what it strips, never more permissive about a real copy.
 * @param source - The file's text.
 * @returns The text with block and line comments removed.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Whether a source spells a sentinel out.
 *
 * Any occurrence in code counts, whatever quotes surround it. The first
 * version looked for the literal wrapped in `"` or `'`, which missed the two
 * forms a real copy is most likely to take: these tools build their results
 * as `` `${SENTINEL}${JSON.stringify(payload)}` ``, so backticks are the local
 * idiom, and inside a template the literal is followed by `${`, not by a
 * closing quote. Neither wrapped form matches that.
 *
 * Importing the constant does not count, because an import names the symbol
 * and never the string.
 *
 * `__ASK_USER__` is not a substring of `__ASK_USER_CHOICE__` — they diverge
 * at the twelfth character — so a plain substring test stays exact across all
 * four. Checked by the samples below.
 * @param source - The file's text.
 * @param literal - The sentinel string.
 * @returns True when the file writes that string out in code.
 */
function spells(source: string, literal: string): boolean {
  return stripComments(source).includes(literal);
}

/** Sources the matcher must catch, and sources it must leave alone. */
const SAMPLES: ReadonlyArray<{ source: string; literal: string; flagged: boolean; why: string }> = [
  { source: `export const ASK_USER_SENTINEL = "__ASK_USER__";`, literal: "__ASK_USER__", flagged: true, why: "a declaration" },
  { source: `if (s.startsWith('__ASK_USER__')) return;`, literal: "__ASK_USER__", flagged: true, why: "single quotes" },
  { source: "const LOCAL = `__ASK_USER__`;", literal: "__ASK_USER__", flagged: true, why: "backticks, the way these tools are written" },
  { source: "return `__ASK_USER__${JSON.stringify(p)}`;", literal: "__ASK_USER__", flagged: true, why: "backticks opening a template with an expression after it" },
  { source: `export const X = "__ASK_USER_CHOICE__";`, literal: "__ASK_USER__", flagged: false, why: "a longer sentinel is not the shorter one" },
  { source: `import { ASK_USER_SENTINEL } from "@breatic/domain";`, literal: "__ASK_USER__", flagged: false, why: "importing the name is the point" },
  { source: `// the __ASK_USER__ prefix marks a question`, literal: "__ASK_USER__", flagged: false, why: "a line comment about it is not a copy of it" },
  { source: `/**\n * Results start with __ASK_USER__.\n */\nexport const x = 1;`, literal: "__ASK_USER__", flagged: false, why: "the same, in a docstring" },
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
