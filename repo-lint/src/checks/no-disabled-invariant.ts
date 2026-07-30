// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { isScannableText } from "#repo-lint/file-kinds";

/**
 * The directive, assembled rather than written.
 *
 * Written out, this file would be the first thing its own rule reports, and
 * it would then need an exemption for itself — one more thing to maintain
 * and one more place a real one could hide. Assembling it means the rule has
 * no exceptions at all.
 */
const DIRECTIVE = ["eslint", "disable"].join("-");

/**
 * A directive comment switching off one or more of this repository's rules.
 *
 * Anchored on a comment opener so a sentence about the directive is not a
 * violation of it — the words appear in this file, in the docs and in the
 * tests, and a scan that matched those would be turned off within a week.
 */
const SWITCHED_OFF = new RegExp(
  `(//|/\\*|\\*)\\s*${DIRECTIVE}(-next-line|-line)?\\s+([^*\\n]*)`,
);

/** Our own rules, as named in a directive. */
const OURS = /breatic\/([a-z0-9-]+)/g;

/**
 * None of this repository's own rules is switched off in a comment.
 *
 * The shell guards these rules replace could not be switched off. There was
 * no syntax for it: a script either found the string or it did not, and a
 * contributor who wanted an exception had to argue for one in the guard.
 * Moving the same invariants into ESLint handed every one of them an escape
 * hatch that did not exist before — one comment, no review trail, no report
 * anywhere that it happened.
 *
 * That matters most for the rules whose whole value is being absolute: no
 * credential in the source, every table reached through its one repository,
 * no relative import, no environment read inside a library. An invariant with
 * a per-line opt-out is a convention, and the repository already decided
 * these are not conventions.
 *
 * Third-party rules are untouched. Switching one of those off is an ordinary
 * judgement call about somebody else's opinion; switching one of ours off is
 * removing a decision this repository made about itself.
 *
 * A rule that genuinely needs an exception gets it where every other
 * exception in this repository lives — in the rule, as a named condition with
 * its reason written down, reviewed once and applying everywhere it should.
 */
export const noDisabledInvariant = {
  name: "no-disabled-invariant",
  description: "None of this repository's own rules is switched off inline",
  run(context: CheckContext): Finding[] {
    const files = context.files(isScannableText, "readable tracked files");

    const findings: Finding[] = [];
    for (const file of files) {
      context
        .read(file)
        .split("\n")
        .forEach((text, index) => {
          const directive = SWITCHED_OFF.exec(text);
          if (!directive) return;
          for (const [, rule] of (directive[3] ?? "").matchAll(OURS)) {
            findings.push({
              file,
              line: index + 1,
              message: `switches off "breatic/${rule}" for this line. These rules replaced shell guards that had no way to be switched off, and the ones worth having are the ones that hold everywhere. If this case genuinely belongs outside the rule, put the exception in the rule with its reason, where it is reviewed once and applies wherever it should.`,
            });
          }
        });
    }
    return findings;
  },
} satisfies Check;
