// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * The private repository's name, assembled rather than written.
 *
 * Spelling it out here would make this file the first violation of its own
 * rule, and then the check would need an exemption for itself — which is an
 * exemption that has to be maintained, and one more place a real violation
 * could hide. Assembling it means the rule has no exceptions at all.
 */
const PRIVATE_REPO = ["breatic", "inner"].join("-");

/** Where the private repo keeps material that must not be cited publicly. */
const PRIVATE_DIRECTORIES = [
  "engineering/(specs|decisions|audit|plans)/",
  "design/decisions/",
];

/** Any reference that reveals the private repository's shape. */
const PRIVATE_REFERENCE = new RegExp(
  [PRIVATE_REPO, ...PRIVATE_DIRECTORIES].join("|"),
);

/** File kinds a person reads. Binaries would only produce noise. */
const TEXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|json|ya?ml|md|css|scss|html|sh|sql)$/;

/** Machine-authored, and large enough to slow every run down. */
const GENERATED = /(^|\/)pnpm-lock\.yaml$/;

/**
 * The public repository does not name paths inside the private one.
 *
 * This repository is public. A comment citing an internal spec by path
 * tells every outside reader that a private repo exists, what it is
 * called, how its directories are laid out, and what a given internal
 * document is named. It is also a dead end for anyone outside the team:
 * they can read the path and never the document.
 *
 * The rule predates the check — an earlier PR was opened specifically to
 * strip such references, and they were back within days, because a rule
 * with no guard is a suggestion.
 *
 * To cite internal material, describe it: "the private engineering
 * record", "an internal design ADR". Better still, state the decision
 * itself in the public comment. A pointer the reader cannot follow is
 * worse than a self-contained sentence.
 *
 * Scanning every tracked text file rather than five directories, because
 * the root README and CLAUDE.md are public artifacts too and the previous
 * scan list did not include them.
 */
export const noPrivateRepoPath = {
  name: "no-private-repo-path",
  description: "The public repo does not cite private-repo paths",
  run(context: CheckContext): Finding[] {
    const files = context.files(
      (path) => TEXT.test(path) && !GENERATED.test(path),
      "public text files",
    );

    const findings: Finding[] = [];
    for (const file of files) {
      context
        .read(file)
        .split("\n")
        .forEach((text, index) => {
          const hit = PRIVATE_REFERENCE.exec(text);
          if (hit) {
            findings.push({
              file,
              line: index + 1,
              message: `Cites the private repository ("${hit[0]}"). Describe the material instead, or state the decision itself — a pointer the reader cannot follow is worse than a self-contained sentence.`,
            });
          }
        });
    }
    return findings;
  },
} satisfies Check;
