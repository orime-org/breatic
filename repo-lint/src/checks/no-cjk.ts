// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Unicode blocks that mean a file is not written in English.
 *
 * Written as codepoint escapes so this file carries no such character
 * itself and is scanned like any other. In JavaScript a character class is
 * matched by codepoint regardless of locale — the shell version needed
 * Perl for this, because GNU grep cannot match a multibyte bracket range
 * in any locale and BSD grep matches it bytewise, which is why the
 * original grep implementation never worked on CI and reported clean for
 * weeks with its error swallowed.
 */
const CJK = /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7A3\uFF00-\uFFEF]/;

/** Files a developer reads and runs, where English is the shared language. */
const SCANNED = /\.(ts|mts|cts|tsx|css|ya?ml|sh|mjs|cjs)$/;

/** Machine-authored, so not anybody's prose. */
const GENERATED = /(^|\/)pnpm-lock\.yaml$/;

/** Product translations — the one place non-English text belongs. */
const LOCALE_CATALOG = /^locales\//;

/** Test fixtures legitimately carry Unicode: that is what they test. */
const TEST = /(^|\/)__tests__\/|\.(test|spec)\.(ts|tsx)$/;

/** Third-party IP, held to its own conventions. */
const VENDOR = /^packages\/web\/src\/components\/ui\//;

/**
 * Files permitted to carry non-English by deliberate design.
 *
 * Keep this short and give every entry its reason. Both current entries are
 * data about languages rather than prose in one: the switcher renders each
 * language in its own script, and the denylist has to spell out the words
 * it forbids.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    "packages/web/src/features/preferences/supported-langs.ts",
    "the language switcher shows each language in its own script; those names are product data and are never localized",
  ],
  [
    "repo-lint/src/checks/product-noun-denylist.ts",
    "the forbidden translations themselves — a denylist cannot be written without the words it denies",
  ],
]);

/**
 * Source, config and shell scripts are written in English.
 *
 * breatic is a global open-source project, so the code a contributor in any
 * country opens has to be readable to them — that covers comments as much
 * as identifiers. Separately, every user-facing string belongs in
 * `locales/*.json` behind `t()`, so CJK in a source string is also a string
 * that was never translated.
 *
 * Scope comes from `git ls-files`, which closes a blind spot the shell
 * version had: it enumerated `find packages`, so the repository root and
 * everything under `scripts/` that was not `.sh` — the `.mjs`, `.cjs` and
 * `.ts` files there — were outside every one of its three scan blocks and
 * reported clean by construction. Measured before the change: widening to
 * every tracked file of these kinds adds no findings beyond the two
 * allowlisted files, so this closes the hole without a cleanup.
 *
 * Documentation is deliberately absent from the scan: prose specs are read
 * by AI as much as by people and are allowed to be Chinese. The rule is
 * about what compiles into the product or gets run.
 */
export const noCjk: Check = {
  name: "no-cjk",
  description: "Source, config and scripts are written in English",
  run(context: CheckContext): Finding[] {
    const files = context.files(
      (path) =>
        SCANNED.test(path) &&
        !GENERATED.test(path) &&
        !LOCALE_CATALOG.test(path) &&
        !TEST.test(path) &&
        !VENDOR.test(path) &&
        !ALLOWED.has(path),
      "source, config and shell scripts",
    );

    const findings: Finding[] = [];
    for (const file of files) {
      const lines = context.read(file).split("\n");
      lines.forEach((text, index) => {
        if (CJK.test(text)) {
          findings.push({
            file,
            line: index + 1,
            message: `Non-English text: ${text.trim().slice(0, 80)}`,
          });
        }
      });
    }
    return findings;
  },
};
