// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { GENERATED, TEST_FILE } from "#repo-lint/file-kinds";

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
 *
 * The ranges start at U+3000 and reach past the basic plane, because a
 * comment written in full-width punctuation is no more English than one
 * written in ideographs. An earlier version began at U+3040 and let every
 * one of the CJK punctuation marks through, along with Bopomofo, the
 * compatibility ideographs and both extension planes. The `u` flag is what
 * makes the last range mean anything: without it a character class cannot
 * hold a codepoint above U+FFFF, so an extension-plane character would be
 * matched as two unrelated halves and neither half is in any range here.
 */
const CJK =
  /[\u3000-\u312F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/u;

/** Files a developer reads and runs, where English is the shared language. */
const SCANNED = /\.(ts|mts|cts|tsx|css|ya?ml|sh|mjs|cjs)$/;

/** Product translations — the one place non-English text belongs. */
const LOCALE_CATALOG = /^locales\//;

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
    "repo-lint/src/product-noun-denylist.ts",
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
/**
 * Every allowlisted path still names a real file.
 *
 * An exemption is a hole with a reason attached, and the reason expires
 * the moment the file does. Left unchecked the entry sits there pointing
 * at nothing until some unrelated file lands on that path and is waved
 * through for a reason that was never about it.
 *
 * This one is not hypothetical: moving the denylist one directory up made
 * its entry stale within the same change. That time the scan went red and
 * said so, because the file still existed somewhere. Delete it instead and
 * nothing would have complained at all.
 * @param context The check context.
 * @throws {Error} When an allowlisted file no longer exists.
 */
function assertAllowlistIsLive(context: CheckContext): void {
  for (const [path, reason] of ALLOWED) {
    if (context.exists(path)) continue;
    throw new Error(
      `${path} is allowlisted here — "${reason}" — but no such file exists. An exemption outliving its file waves through whatever lands on that path next; remove the entry or fix the path.`,
    );
  }
}

export const noCjk = {
  name: "no-cjk",
  description: "Source, config and scripts are written in English",
  run(context: CheckContext): Finding[] {
    assertAllowlistIsLive(context);
    const files = context.files(
      (path) =>
        SCANNED.test(path) &&
        !GENERATED.test(path) &&
        !LOCALE_CATALOG.test(path) &&
        !TEST_FILE.test(path) &&
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
} satisfies Check;
