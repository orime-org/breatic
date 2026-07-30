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

/**
 * Where the private repo keeps material that must not be cited publicly.
 *
 * Assembled for the same reason as the name above: written out, this file
 * would be the first thing its own rule catches, and it would then need an
 * exemption — which is a thing to maintain and a place a real violation
 * could hide.
 */
const PRIVATE_DIRECTORIES = [
  `${["engineering", "(specs|decisions|audit|plans)"].join("/")}/`,
  `${["design", "decisions"].join("/")}/`,
];

/** Any reference that reveals the private repository's shape. */
const PRIVATE_REFERENCE = new RegExp(
  [PRIVATE_REPO, ...PRIVATE_DIRECTORIES].join("|"),
);

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
 * Scanning every tracked file whose bytes are text, rather than a list of
 * source extensions: the root README and CLAUDE.md are public artifacts, and
 * so are the Dockerfiles, the env templates and the commit hooks, none of
 * which carry an extension a list would have named.
 */
export const noPrivateRepoPath = {
  name: "no-private-repo-path",
  description: "The public repo does not cite private-repo paths",
  run(context: CheckContext): Finding[] {
    const files = context.textFiles(() => true, "readable tracked files");

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
