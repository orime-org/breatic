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

/**
 * What a licence group holds, as `pnpm licenses list --json` reports it.
 *
 * `paths` carries one directory per installed version, in the same order as
 * `versions`; 47 of web's 686 entries carry more than one.
 */
export interface LicensedPackage {
  readonly name: string;
  readonly versions: string[];
  readonly paths: string[];
  readonly license: string;
  // pnpm omits this key rather than emitting an empty string.
  readonly homepage?: string;
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
 * Whether an entry states one licence identifier.
 *
 * The bound on either side is the SPDX identifier character set, so one
 * identifier cannot pass as a prefix of another: `Unlicense` is a real licence
 * and `UNLICENSED` means the metadata names none, and a plain substring test
 * reads the second as stating the first.
 * @param entry - One entry of the notice, lower-cased.
 * @param term - One licence identifier, lower-cased.
 * @returns True when the entry states exactly that identifier.
 */
function states(entry: string, term: string): boolean {
  const escaped = term.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(
    String.raw`(?<![a-z0-9.+-])${escaped}(?![a-z0-9.+-])`,
  ).test(entry);
}

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
 * @throws {Error} When the heading is not there to cut at.
 */
function distributedHalf(notice: string): string {
  const cut = notice.indexOf(NOT_DISTRIBUTED);
  if (cut === -1) {
    throw new Error(
      `The notice has no "${NOT_DISTRIBUTED}" heading, so there is nothing ` +
        `to cut the distributed half at and every name below it would start ` +
        `counting as declared. Restore the heading, or teach this where the ` +
        `new one is.`,
    );
  }
  return notice.slice(0, cut);
}

/**
 * The entries in the distributed half, split where each one starts.
 *
 * A table row is an entry of its own. Several packages share one `###`
 * heading — the two summary tables hold seven between them — and judging a
 * licence over the whole section lets any row's licence vouch for any other's
 * package, which is the one thing the mismatch reason exists to catch.
 * @param notice - The whole file.
 * @returns One string per entry, lower-cased for matching.
 */
function entriesOf(notice: string): string[] {
  return distributedHalf(notice)
    .toLowerCase()
    .split(/^(?:###\s+|\|\s*`)/m);
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
      const naming = entries.filter((text) => text.includes(name));
      if (naming.length === 0) {
        gaps.push({ ...pkg, licence, reason: "missing" });
        continue;
      }
      // Having a name is not the same as saying anything true beside it: one
      // entry has to state every term the tool reported. Any entry, not the
      // first to name the package — entries cross-reference each other, and a
      // mention in someone else's prose is not this package's entry.
      const covered = naming.some((entry) =>
        terms(licence).every((term) => states(entry, term)),
      );
      if (!covered) {
        gaps.push({ ...pkg, licence, reason: "licence-mismatch" });
      }
    }
  }

  return gaps;
}
