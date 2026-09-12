// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LicensedPackage } from "#repo-lint/licence-coverage";

/**
 * The third-party licence notice that ships inside the front-end bundle.
 *
 * MIT and OFL-1.1 both ask for their full text to travel with every copy of
 * the software, and a browser receives a copy on each visit. The bundle
 * carries none of it: the build strips comments, so what survives is four
 * `/*!` banners out of several hundred packages. This assembles the text the
 * licences ask for, from the licence files already on disk.
 *
 * Reads the report `pnpm licenses list --json` produces, which is the same
 * source the `notice-covers-dependencies` check reads, so the two can never
 * disagree about which packages exist or what they are licensed under.
 */

/** Whatever upstream chose to call its licence file. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)/i;

/** Where the standard texts sit, for packages that ship none of their own. */
const TEXTS = fileURLToPath(new URL("./licence-texts/", import.meta.url));

/** The SPDX identifiers a standard text is held for, lowercased. */
const STANDARD = new Map([
  ["mit", "mit.txt"],
  ["apache-2.0", "apache-2.0.txt"],
  ["bsd-2-clause", "bsd-2-clause.txt"],
]);

/**
 * The licence text a package ships, when it ships one.
 *
 * Takes the first path that has one: a package installed at several versions
 * gets one entry here, and in the 47 multi-version entries measured no two
 * versions carried different words.
 * @param paths - Every directory the package is installed at.
 * @returns The text, or undefined when no version ships a file.
 */
function shippedText(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      continue;
    }
    const found = names.find((name) => LICENCE_FILE.test(name));
    if (found === undefined) continue;
    try {
      return readFileSync(join(path, found), "utf8").trim();
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The standard text for a licence a package declared but shipped no file for.
 * @param licence - The SPDX identifier from the report.
 * @param name - The package, named so a failure says which one provoked it.
 * @returns The standard text.
 * @throws {Error} When no standard text is held for that identifier.
 */
function standardText(licence: string, name: string): string {
  const file = STANDARD.get(licence.toLowerCase());
  if (file === undefined) {
    throw new Error(
      `${name} declares ${licence} and ships no licence file, and no standard ` +
        `text is held for ${licence}. Add one under repo-lint/src/licence-texts/, ` +
        `or find out why the package stopped shipping its own.`,
    );
  }
  return readFileSync(join(TEXTS, file), "utf8").trim();
}

/**
 * The third-party licence notice, as plain text.
 * Carries no timestamp: the contents follow from the installed packages, and
 * a clock reading would make every regeneration differ from the committed
 * copy, which is the one thing the check comparing them cannot tolerate.
 * @param groups - What `pnpm licenses list --json` reported.
 * @returns The notice.
 * @throws {Error} When a licence has neither a file on disk nor a standard text.
 */
export function buildLicenceNotice(
  groups: Record<string, LicensedPackage[]>,
): string {
  const entries = Object.values(groups)
    .flat()
    .sort((a, b) => a.name.localeCompare(b.name));

  // Several hundred packages share a few dozen distinct texts, so key by the
  // words themselves: one MIT text with one attribution line reaches every
  // package that wrote it, and appears once.
  const texts = new Map<string, string[]>();
  const listed: string[] = [];

  for (const entry of entries) {
    const text =
      shippedText(entry.paths) ?? standardText(entry.license, entry.name);
    const carriers = texts.get(text);
    if (carriers === undefined) texts.set(text, [entry.name]);
    else carriers.push(entry.name);

    const where = entry.homepage === "" ? "" : `  ${entry.homepage}`;
    listed.push(
      `${entry.name} ${entry.versions.join(", ")}  ${entry.license}${where}`,
    );
  }

  const bodies = [...texts.entries()].map(
    ([text, carriers], index) =>
      `${"-".repeat(72)}\n` +
      `Licence ${index + 1} of ${texts.size} — applies to: ${carriers.join(", ")}\n` +
      `${"-".repeat(72)}\n\n${text}\n`,
  );

  return [
    "THIRD-PARTY LICENCES",
    "",
    "This page carries the licence of every third-party package in the",
    "production dependency closure of the breatic front end. It is generated",
    "from the installed packages themselves, so the words below are the words",
    "each author shipped. Where a package declared a licence without shipping",
    "its text, the standard text of that licence stands in its place and the",
    "copyright holder is the one named at the package's home page.",
    "",
    `Packages ${entries.length}, distinct licence texts ${texts.size}`,
    "",
    "Regenerate with: pnpm --filter @breatic/repo-lint licences",
    "",
    "",
    "PACKAGES",
    "",
    ...listed,
    "",
    "",
    "LICENCE TEXTS",
    "",
    ...bodies,
  ].join("\n");
}
