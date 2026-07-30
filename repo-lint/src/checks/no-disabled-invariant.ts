// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * The two leading words, assembled rather than written.
 *
 * Written out, this file would be the first thing its own check reports, and
 * it would then need an exemption for itself — one more thing to maintain
 * and one more place a real one could hide. Assembling them means the check
 * has no exceptions at all.
 */
const DIRECTIVE = ["eslint", "disable"].join("-");
const CONFIG = ["es", "lint"].join("");

/**
 * A directive comment, with everything that follows it on the line.
 *
 * Anchored on a comment opener so a sentence about the directive is not a
 * violation of it — the words appear in this file, in the docs and in the
 * tests, and a scan that matched those would be turned off within a week.
 *
 * What follows is captured whole rather than required to be non-empty. A
 * directive that names no rule is the most damaging form there is, and the
 * first version of this check demanded a rule name and so saw none of them.
 */
const DIRECTIVE_COMMENT = new RegExp(
  `(?://|/\\*|\\*)\\s*${DIRECTIVE}(?:-next-line|-line)?\\b(.*)`,
);

/**
 * An inline configuration comment, with its body.
 *
 * A second syntax entirely, and the one ESLint is silent about: measured
 * against ESLint 10, a rule switched off this way produces no message and no
 * entry in `suppressedMessages` either. Requiring whitespace after the word
 * is what separates it from the directive above, which continues with `-`.
 */
const CONFIG_COMMENT = new RegExp(`(?://|/\\*|\\*)\\s*${CONFIG}\\s+(.*)`);

/** Our own rules, as named in a directive. */
const OURS = /breatic\/([a-z0-9-]+)/g;

/**
 * One of our rules given a severity in an inline config comment.
 *
 * Both spellings of every severity: ESLint accepts the words and the numbers
 * interchangeably, and a scan that knew only the words would be answered with
 * a digit.
 */
const OURS_CONFIGURED = /breatic\/([a-z0-9-]+)\s*:\s*(?:"([a-z]+)"|'([a-z]+)'|(\d))/g;

/** Severities that stop a rule failing the build. */
const SILENCED = new Set(["off", "0", "warn", "1"]);

/**
 * Strips what ESLint does not read as rule names.
 *
 * A description after `--` is prose, and a block comment's terminator is
 * punctuation; counting either as a rule name would let a rule-less directive
 * pass by carrying a reason.
 * @param rest Everything following the directive on the line.
 * @returns The part ESLint parses as a rule list.
 */
function ruleList(rest: string): string {
  return rest.split("--")[0]?.replace(/\*\/.*$/, "").trim() ?? "";
}

/** Where an exception belongs instead, said the same way in every message. */
const REMEDY =
  "If this case genuinely belongs outside the rule, put the exception in the rule with its reason, where it is reviewed once and applies wherever it should.";

/**
 * Judges one line for every syntax that switches one of our rules off.
 *
 * The two syntaxes are checked in order rather than together because the
 * directive begins with the same word the inline configuration comment does,
 * and a line is only ever one of them.
 * @param file Repo-relative path, for the finding.
 * @param line One-based line number, for the finding.
 * @param text The line's text.
 * @returns One finding per rule this line silences.
 */
function judgeLine(file: string, line: number, text: string): Finding[] {
  const directive = DIRECTIVE_COMMENT.exec(text);
  if (directive) {
    const named = ruleList(directive[1] ?? "");
    if (named === "") {
      return [
        {
          file,
          line,
          message: `switches off every rule here, this repository's included. A directive naming no rule is the widest form there is: it takes the fewest characters to write and removes the most, and nothing downstream records that it happened. ${REMEDY}`,
        },
      ];
    }
    return [...named.matchAll(OURS)].map(([, rule]) => ({
      file,
      line,
      message: `switches off "breatic/${rule}" for this line. These rules replaced shell guards that had no way to be switched off, and the ones worth having are the ones that hold everywhere. ${REMEDY}`,
    }));
  }

  const config = CONFIG_COMMENT.exec(text);
  if (!config) return [];
  return [...(config[1] ?? "").matchAll(OURS_CONFIGURED)]
    .filter(([, , word, quoted, digit]) =>
      SILENCED.has(word ?? quoted ?? digit ?? ""),
    )
    .map(([, rule, word, quoted, digit]) => ({
      file,
      line,
      message: `sets "breatic/${rule}" to ${word ?? quoted ?? digit} in an inline configuration comment, which stops it failing the build. ESLint reports nothing when a rule is silenced this way — not a message, and not an entry in suppressedMessages either — so this scan is the only place it can be seen. ${REMEDY}`,
    }));
}

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
    const files = context.textFiles("readable tracked files");

    const findings: Finding[] = [];
    for (const file of files) {
      context
        .read(file)
        .split("\n")
        .forEach((text, index) => {
          findings.push(...judgeLine(file, index + 1, text));
        });
    }
    return findings;
  },
} satisfies Check;
