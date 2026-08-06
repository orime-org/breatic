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

/**
 * The private repository's short name, which is how a reference to it is
 * actually written in this tree.
 *
 * Safe to spell out, unlike the two constants above, because the word alone
 * is not a violation: a finding needs it adjacent to a slash or to one of the
 * pointer words below, and nothing in this file puts it there. That is not a
 * loophole — the word on its own carries no information about a repository,
 * and matching it would end the check. Measured before this was widened: it
 * appears 77 times in the tree, every one of them ordinary code
 * (`function inner()`, an inner loop, an object key).
 */
const MARKER = "inner";

/**
 * What turns the short name into a pointer at the private repository.
 *
 * A slash after it makes a path. One of these words after it makes a
 * citation: an id (`ADR`, a `#` number), a document kind (`spec`), or one of
 * the repository's own directory names. All were measured at zero
 * occurrences before the widening, so nothing in the tree changes verdict
 * except the five real breaches this closes.
 */
const POINTER_WORDS = [
  "ADR",
  "specs?",
  "engineering",
  "design",
  "decisions",
  "audit",
  "plans",
  "demo",
  "research",
].join("|");

/**
 * Naming the private repository, in the forms it is actually written in.
 *
 * The directory list above matches a layout; this matches a pointer. Both
 * exist because the tree contains both, and the second is the one the
 * original list could not see: four tracked files cited a probe script by
 * path, in a directory the list never named, while this check reported clean.
 */
const REPO_POINTERS = [
  `\\b${MARKER}/`,
  `\\b${MARKER}\\s+(?:${POINTER_WORDS})\\b`,
  `\\b${MARKER}\\s+#\\d`,
  // The Chinese word for "repository", written as an escape so this file
  // stays inside the no-cjk rule that governs every TypeScript source.
  `\\b${MARKER}\\s*\\u4ed3`,
];

/** Any reference that names the private repository. */
const PRIVATE_REFERENCE = new RegExp(
  [PRIVATE_REPO, ...PRIVATE_DIRECTORIES, ...REPO_POINTERS].join("|"),
);

/**
 * The public repository does not name the private one.
 *
 * This repository is public, and a comment that cites internal material by
 * name or by path is a dead end for anyone outside the team: they can read
 * the pointer and never the document. That cost is the whole of it, and it
 * is a readability cost rather than a security one — see the boundary below,
 * which is where this check deliberately stops.
 *
 * The rule predates the check — an earlier PR was opened specifically to
 * strip such references, and they were back within days, because a rule
 * with no guard is a suggestion.
 *
 * HOW TO WRITE A REFERENCE THAT PASSES, and these are the forms already in
 * the tree rather than shapes invented here:
 *
 *   state the decision itself   the best one. The reader needs the fact, not
 *                               a door they cannot open
 *   an id with a date           `ADR 2026-05-31`, used in eslint.config.ts
 *                               and the dependency-cruiser config
 *   a topic with a date         `access-permission design (2026-05-28) § 5`,
 *                               used in the members components
 *   describe the material       "the private engineering record", "measured
 *                               with a probe kept outside this repository"
 *
 * WHERE THIS STOPS, ratified 2026-08-06 and deliberately not wider. The rule
 * is about NAMING the private repository — its name, or its short name used
 * as a pointer. A path fragment that happens to live there but names no
 * repository (`design/project/x.md`, `bugs/audit/x.md`) is NOT a violation,
 * and one of the tests below pins that so the criterion cannot be quietly
 * re-widened.
 *
 * Three things settled it, each measured rather than argued. What such a
 * filename actually reveals is of the order "a design document for the
 * mini-tool system exists", which is not a secret. Knowing the repository's
 * name grants nothing: a private repository answers 404 to anyone who is not
 * a member, so there is no next step to take. And enumerating the private
 * repository's own directory names cannot work — several are ordinary words
 * this repository uses for itself, so a list of them would report the
 * Dockerfile's build output and every path under the web package.
 *
 * The one thing a filename can genuinely leak is a TOPIC — an incident, an
 * unannounced price change. No check can judge that, and none here tries;
 * it is on whoever writes the reference.
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
