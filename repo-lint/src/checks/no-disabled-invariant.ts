// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
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
 * An inline configuration comment, with its body, wherever it sits.
 *
 * A second syntax entirely, and the one ESLint is silent about: measured
 * against ESLint 10, a rule switched off this way produces no message and no
 * entry in `suppressedMessages` either. Requiring whitespace after the word
 * is what separates it from the directive above, which continues with `-`.
 *
 * Matched over the whole file rather than line by line, because a block
 * comment may wrap — and a scan that read one line at a time saw the opening
 * without the rule name and the rule name without the opening, so neither
 * half looked like anything.
 */
const CONFIG_COMMENTS = new RegExp(
  `/\\*\\s*${CONFIG}\\s+([\\s\\S]*?)\\*/|//\\s*${CONFIG}\\s+(.*)`,
  "g",
);

/** Our own rules, as named in a directive. */
const OURS = /breatic\/([a-z0-9-]+)/g;

/**
 * One of our rules given a severity in an inline config comment.
 *
 * The rule id may be quoted — that is the spelling this repository's own
 * configs use — and the severity may be a word, a number, or either wrapped
 * in an array alongside options. Rather than enumerate those, the value is
 * captured up to the next entry and asked one question: does it say error.
 * Everything else silences the rule to some degree, and an enumeration is
 * what let the array spelling through.
 */
const OURS_CONFIGURED = /["']?breatic\/([a-z0-9-]+)["']?\s*:\s*([^,]*)/g;

/**
 * Whether a severity still fails the build.
 * @param value The text following the colon, up to the next entry.
 * @returns True when the rule remains an error.
 */
function staysAnError(value: string): boolean {
  return /\berror\b|\b2\b/.test(value);
}

/**
 * Strips what ESLint does not read as configuration.
 *
 * A description after `--` is prose, and a block comment's terminator is
 * punctuation. ESLint accepts a description after either comment syntax, so
 * both callers below strip it here rather than each in its own way — which is
 * how it came to be stripped for directives and not for configuration
 * comments. Left in, prose is read as configuration: a reason for silencing a
 * rule says the word "error" more often than not, and the value parser then
 * read the rule as still failing the build and said nothing.
 * @param text Everything following the comment's opening word.
 * @returns The part ESLint parses as configuration.
 */
function withoutDescription(text: string): string {
  return text.split("--")[0]?.replace(/\*\/.*$/, "").trim() ?? "";
}

/** Where an exception belongs instead, said the same way in every message. */
const REMEDY =
  "If this case genuinely belongs outside the rule, put the exception in the rule with its reason, where it is reviewed once and applies wherever it should.";

/**
 * Judges one line for a directive comment switching off our rules.
 * @param file Repo-relative path, for the finding.
 * @param line One-based line number, for the finding.
 * @param text The line's text.
 * @returns One finding per rule this line silences.
 */
function judgeDirective(file: string, line: number, text: string): Finding[] {
  const directive = DIRECTIVE_COMMENT.exec(text);
  if (!directive) return [];
  const named = withoutDescription(directive[1] ?? "");
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

/**
 * Judges a whole file for configuration comments that weaken our rules.
 *
 * Whole-file rather than per-line: a block comment may wrap, and it may share
 * a line with a directive. Both were invisible to a scan that read one line
 * and decided it was one syntax or the other.
 * @param file Repo-relative path, for the finding.
 * @param text The file's contents.
 * @returns One finding per rule a configuration comment weakens.
 */
function judgeConfigComments(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const comment of text.matchAll(CONFIG_COMMENTS)) {
    const body = withoutDescription(comment[1] ?? comment[2] ?? "");
    const line = text.slice(0, comment.index).split("\n").length;
    for (const [, rule, value] of body.matchAll(OURS_CONFIGURED)) {
      if (staysAnError(value ?? "")) continue;
      findings.push({
        file,
        line,
        message: `sets "breatic/${rule}" to something other than an error in a configuration comment, which stops it failing the build. ESLint reports nothing when a rule is weakened this way — not a message, and not an entry in suppressedMessages either — so this scan is the only place it can be seen. ${REMEDY}`,
      });
    }
  }
  return findings;
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
    const files = context.textFiles(() => true, "readable tracked files");

    const findings: Finding[] = [];
    for (const file of files) {
      const text = context.read(file);
      text.split("\n").forEach((line, index) => {
        findings.push(...judgeDirective(file, index + 1, line));
      });
      findings.push(...judgeConfigComments(file, text));
    }
    return findings;
  },
} satisfies Check;
