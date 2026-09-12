// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which installed packages the third-party notice still owes an entry.
 *
 * `THIRD-PARTY.md` sets the threshold itself: a dependency that reaches a
 * published artefact and carries a licence other than MIT, Apache-2.0, BSD or
 * ISC gets an entry. Until now a person had to remember to go and check. This
 * is that rule, decided from data rather than memory.
 *
 * Pure, so the judgement is testable without a repository: the caller runs
 * `pnpm licenses list` and reads the file.
 */

/** What a licence group holds, as `pnpm licenses list --json` reports it. */
export interface LicensedPackage {
  readonly name: string;
  readonly versions: string[];
}

/** Why a package needs attention. */
export type CoverageReason = "missing" | "licence-mismatch";

/** One package the notice does not account for. */
export interface CoverageGap {
  readonly name: string;
  readonly licence: string;
  readonly versions: string[];
  readonly reason: CoverageReason;
}

/**
 * The licences permissive enough that listing every one of them would bury
 * the entries that matter. `THIRD-PARTY.md` names these four; the variants
 * are the same four as SPDX spells them.
 */
const PERMISSIVE = new Set([
  "mit",
  "mit-0",
  "apache-2.0",
  "0bsd",
  "bsd",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
]);

/**
 * The heading after which the notice describes what it does NOT distribute.
 *
 * That section's own words are "These never reach a published artefact." A
 * name written there says the opposite of "declared", so the search stops
 * here — otherwise the check goes green on exactly the state the file calls
 * wrong.
 */
const NOT_DISTRIBUTED = "## Build and development tools";

/**
 * Every alternative an SPDX expression offers.
 * @param expression - What the tool reported for a package.
 * @returns The terms, parentheses and AND joins flattened away.
 */
function terms(expression: string): string[] {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);
}

/**
 * Whether taking this package needs no entry.
 *
 * Every term has to be permissive, not just one. A dual offer such as
 * `MIT OR GPL-3.0-or-later` means we elect the MIT half, and the election is
 * the thing the notice records — its own DOMPurify entry is written that way.
 * @param expression - The licence expression to judge.
 * @returns True when nothing about this package needs writing down.
 */
function isFullyPermissive(expression: string): boolean {
  const parts = terms(expression);
  return parts.length > 0 && parts.every((term) => PERMISSIVE.has(term));
}

/**
 * The part of the notice that describes what we distribute.
 * @param notice - The whole file.
 * @returns Everything above the build-tools heading.
 */
function distributedHalf(notice: string): string {
  const cut = notice.indexOf(NOT_DISTRIBUTED);
  return cut === -1 ? notice : notice.slice(0, cut);
}

/**
 * The entries in the distributed half, split where each one starts.
 * @param notice - The whole file.
 * @returns One string per entry, lower-cased for matching.
 */
function entriesOf(notice: string): string[] {
  return distributedHalf(notice).toLowerCase().split(/^###\s+/m);
}

/**
 * Which packages the notice still owes an entry, and which it describes wrong.
 * @param groups - Licence expression to the packages under it.
 * @param notice - The contents of `THIRD-PARTY.md`.
 * @returns One gap per package, name-ordered within each licence.
 */
export function licenceCoverage(
  groups: Record<string, LicensedPackage[]>,
  notice: string,
): CoverageGap[] {
  const entries = entriesOf(notice);
  const gaps: CoverageGap[] = [];

  for (const [licence, packages] of Object.entries(groups)) {
    if (isFullyPermissive(licence)) continue;
    for (const pkg of packages) {
      // The notice writes `DOMPurify` where the package is `dompurify`, so the
      // name is matched without case. Its entries quote names in backticks and
      // also use them as headings, and both forms count.
      const name = pkg.name.toLowerCase();
      const entry = entries.find((text) => text.includes(name));
      if (entry === undefined) {
        gaps.push({ ...pkg, licence, reason: "missing" });
        continue;
      }
      // Having a name is not the same as saying anything true beside it. Every
      // term the tool reported has to appear in the same entry.
      const stated = terms(licence).every((term) => entry.includes(term));
      if (!stated) {
        gaps.push({ ...pkg, licence, reason: "licence-mismatch" });
      }
    }
  }

  return gaps;
}
