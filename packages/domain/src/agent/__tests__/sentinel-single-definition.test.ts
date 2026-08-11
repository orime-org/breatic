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
 * Whether a source writes a sentinel out.
 *
 * Anywhere in the file counts — any quotes, or none, code or comment. Two
 * narrower versions came before this one and each had a hole:
 *
 * Looking for the literal wrapped in `"` or `'` missed the two forms a real
 * second copy is most likely to take, because these tools build their results
 * as `` `${SENTINEL}${JSON.stringify(payload)}` ``: backticks are the local
 * idiom, and inside a template the literal is followed by `${` rather than by
 * a closing quote.
 *
 * Stripping comments first, to let prose mention a sentinel without counting
 * as a copy, was worse. Telling a comment from a string needs a parser, and
 * two regexes are not one: `//` inside a string deletes the rest of that line,
 * and `/*` inside a string opens a block that runs to the next `*` + `/`.
 * Measured on this repo — `packages/server/src/routes/assets.ts` has a route
 * pattern ending in `/` + `*`, and stripping deleted 60% of the file (33259
 * characters to 13134). A real second copy planted in that deleted region was
 * not found; the same copy at the top of the file was. Every character
 * stripping removes is a character the search cannot see, so a crude stripper
 * does not err on the side of strictness — it errs the only way that matters.
 *
 * Dropping the distinction removes the hole rather than narrowing it, at one
 * price: prose in a scanned file must name the constant, not the string. That
 * is the better way to write it anyway, since a name follows the value.
 *
 * Importing the constant is untouched, because an import names the symbol and
 * never the string. And `__ASK_USER__` is not a substring of
 * `__ASK_USER_CHOICE__` — they diverge at the twelfth character — so a plain
 * substring test stays exact across all four. Both checked by the samples.
 * @param source - The file's text.
 * @param literal - The sentinel string.
 * @returns True when the file writes that string out.
 */
function spells(source: string, literal: string): boolean {
  return source.includes(literal);
}

/** Sources the matcher must catch, and sources it must leave alone. */
const SAMPLES: ReadonlyArray<{ source: string; literal: string; flagged: boolean; why: string }> = [
  { source: `export const ASK_USER_SENTINEL = "__ASK_USER__";`, literal: "__ASK_USER__", flagged: true, why: "a declaration" },
  { source: `if (s.startsWith('__ASK_USER__')) return;`, literal: "__ASK_USER__", flagged: true, why: "single quotes" },
  { source: "const LOCAL = `__ASK_USER__`;", literal: "__ASK_USER__", flagged: true, why: "backticks, the way these tools are written" },
  { source: "return `__ASK_USER__${JSON.stringify(p)}`;", literal: "__ASK_USER__", flagged: true, why: "backticks opening a template with an expression after it" },
  { source: `export const X = "__ASK_USER_CHOICE__";`, literal: "__ASK_USER__", flagged: false, why: "a longer sentinel is not the shorter one" },
  { source: `import { ASK_USER_SENTINEL } from "@breatic/domain";`, literal: "__ASK_USER__", flagged: false, why: "importing the name is the point" },
  { source: `// the __ASK_USER__ prefix marks a question`, literal: "__ASK_USER__", flagged: true, why: "prose counts too — say ASK_USER_SENTINEL instead" },
  { source: `/**\n * Results start with __ASK_USER__.\n */\nexport const x = 1;`, literal: "__ASK_USER__", flagged: true, why: "the same, in a docstring" },
  { source: `const DOCS = "https://example.test/a"; const LOCAL = "__ASK_USER__";`, literal: "__ASK_USER__", flagged: true, why: "a URL earlier on the line hid this from the version that stripped comments" },
  { source: `route("/local-upload/*", h);\nconst LOCAL = "__ASK_USER__";`, literal: "__ASK_USER__", flagged: true, why: "a route pattern ending in a slash-star hid the whole rest of the file from that version" },
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
