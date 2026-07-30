// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every name the deleted dev-bypass auth mode went by.
 *
 * Assembled rather than written out, so this file is not the first thing
 * its own check reports and does not need an exemption for itself. An
 * exemption is a thing to maintain and a place a real residue could hide.
 *
 * The list is the single source of truth: the pattern is derived from it,
 * never written alongside it, so the two cannot disagree.
 *
 * Exported so the tests plant every entry rather than a sample of them. A
 * test naming three of eight reads as covering the list, and the name added
 * ninth would arrive with nothing exercising it.
 */
export const BYPASS_NAMES: ReadonlyArray<readonly [string, string]> = [
  // The mode switch, backend and frontend.
  [["LOGIN", "MODE"].join("_"), "the mode switch"],
  [["VITE", "LOGIN", "MODE"].join("_"), "the frontend mode switch"],
  // Both of the switch's values.
  [["No", "Account"].join(""), "the bypass value of the switch"],
  [["With", "Account"].join(""), "the other value of the switch"],
  // The fixed identity it handed out.
  [["DEV", "USER", "ID"].join("_"), "the fixed identity it issued"],
  [["dev", "fixed", "token"].join("-"), "the fixed token it issued"],
  // The frontend bypass itself.
  [["inject", "dev", "user"].join("-"), "the frontend bypass module"],
  [`${["inject", "Dev"].join("")}User`, "the frontend bypass symbol"],
];

/**
 * Files that name the mode legitimately.
 *
 * One entry, and it is history rather than an escape hatch: the migration
 * that deleted the mock user has to name what it is deleting.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    "packages/core/src/db/migrations/0016_delete-dev-mock-user.sql",
    "the migration that removed the mock user has to name what it removes",
  ],
]);

/**
 * Nothing in the repository names the deleted auth-bypass mode.
 *
 * Every environment requires a real login and there is no switch left to
 * flip. A surviving mention does one of two things, both bad: it tells the
 * reader that auth is optional somewhere, or — inside a workflow's `env:`
 * block — it actually puts the bypass back.
 *
 * Scope is every tracked file, with no extension filter, because the four
 * residues that motivated this were a README, a spike script, a Dockerfile
 * with no extension at all, and both env templates. A list of extensions
 * would have missed three of them.
 *
 * Comments are not stripped, deliberately. A comment saying the mode used
 * to exist still tells a reader auth might be optional, and the mode is
 * gone, so there is nothing to describe.
 */
export const noAuthBypassResidue = {
  name: "no-auth-bypass-residue",
  description: "Nothing names the deleted auth-bypass mode",
  run(context: CheckContext): Finding[] {
    if (BYPASS_NAMES.length === 0) {
      throw new Error(
        "the forbidden-name list is empty, so this check would match nothing",
      );
    }
    for (const [name] of BYPASS_NAMES) {
      if (name === "") {
        throw new Error(
          "a forbidden name is the empty string, which matches every line",
        );
      }
    }

    const files = context.textFiles(
      (path) => !ALLOWED.has(path),
      "tracked files outside the allowlist",
    );

    const findings: Finding[] = [];
    for (const file of files) {
      const text = context.read(file);
      text.split("\n").forEach((line, index) => {
        for (const [name, what] of BYPASS_NAMES) {
          if (!line.includes(name)) continue;
          findings.push({
            file,
            line: index + 1,
            message: `Names '${name}' — ${what} of the deleted dev-bypass auth mode. Every environment requires a real login and there is no switch left to flip, so a mention either misleads the reader or, in a workflow env block, puts the bypass back.`,
          });
        }
      });
    }
    return findings;
  },
} satisfies Check;
