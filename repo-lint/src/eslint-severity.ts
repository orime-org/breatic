// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { ESLint } from "eslint";
import { dirname, join } from "node:path";

/** The severity a rule ends up with, normalised across ESLint's two spellings. */
export type Severity = "off" | "warn" | "error";

/** Config files ESLint reads, in every extension flat config allows. */
export const CONFIG_FILE = /(^|\/)eslint\.config\.(m?[jt]s|cjs)$/;

/** How the three severities order, loudest last. */
const RANK: Record<Severity, number> = { off: 0, warn: 1, error: 2 };

/**
 * Normalises the severity of one rule entry.
 *
 * ESLint accepts the words and the numbers interchangeably, and hands back
 * whichever the config used — wrapped in an array when the rule carries
 * options. A comparison against one spelling silently misreads the other.
 * @param entry The rule's value in a calculated config.
 * @returns Which of the three severities it is.
 */
export function severityOf(entry: unknown): Severity {
  const value = Array.isArray(entry) ? entry[0] : entry;
  if (value === 0 || value === "off") return "off";
  if (value === 1 || value === "warn") return "warn";
  return "error";
}

/**
 * Asks ESLint about one file and keeps whichever severity is loudest so far.
 *
 * Both callers below ask a different question of ESLint and then do exactly
 * this with the answer; written twice, the two copies drift, which is how a
 * spelling ends up handled in one place and not the other.
 * @param eslint The instance to ask.
 * @param file The path to ask about, as that instance resolves paths.
 * @param loudest The map to fold the answer into. Mutated.
 * @throws {Error} When ESLint cannot calculate a config for the file.
 */
async function foldFile(
  eslint: ESLint,
  file: string,
  loudest: Map<string, Severity>,
): Promise<void> {
  // Undefined for a path the config ignores — measured against ESLint 10,
  // which answers that way rather than throwing. An ignored file has no
  // severities to contribute, and reading through the undefined threw a
  // TypeError naming neither the file nor this check.
  const config = await eslint.calculateConfigForFile(file);
  if (config === undefined || config === null) return;
  for (const [id, entry] of Object.entries(config.rules ?? {})) {
    const severity = severityOf(entry);
    const seen = loudest.get(id);
    if (seen === undefined || RANK[severity] > RANK[seen]) {
      loudest.set(id, severity);
    }
  }
}

/**
 * Asks ESLint which of our rules actually run, and how loudly.
 *
 * The question "is this rule switched on" is one only ESLint can answer.
 * Reading the config text cannot: a rule can be set to "off", commented out,
 * declared behind a glob that never matches, or named through a variable, and
 * every one of those reads as enabled to a scan looking for its name. Asking
 * ESLint for the config it will really use collapses all of those into the
 * same answer, and keeps answering correctly when the config is rewritten.
 * @param repoRoot Absolute path of the repository root.
 * @param configDirs Repo-relative directories holding an eslint config.
 * @param files Repo-relative source files the configs govern.
 * @returns For each rule name, the loudest severity it reaches anywhere.
 * @throws {Error} When ESLint cannot calculate a config for a probe file.
 */
export async function loudestSeverities(
  repoRoot: string,
  configDirs: readonly string[],
  files: readonly string[],
): Promise<Map<string, Severity>> {
  const loudest = new Map<string, Severity>();
  const roots = [...configDirs];

  for (const root of roots) {
    const owned = files.filter((file) =>
      root === "" ? true : file.startsWith(`${root}/`),
    );
    // Attribution stated rather than assumed: a file under a deeper config
    // directory belongs to that directory, so it is dropped from this one.
    // ESLint 10 resolves each file's config from the file's own location and
    // would attribute them the same way unasked — but that is a default, and
    // it is the opposite of the ESLint 9 default it replaced. Saying which
    // config governs which file keeps this answer the same across that kind
    // of change instead of quietly following it.
    //
    // Every file, not a sample of them. A rule's glob can be as narrow as one
    // filename — service-observability names the three service entries, and
    // test-file-location only ever matches a test — so a representative file
    // per package answers "this rule reaches nothing" for rules that reach
    // exactly the files the sample left out.
    const probes = owned.filter(
      (file) =>
        !roots.some(
          (other) => other.length > root.length && file.startsWith(`${other}/`),
        ),
    );
    if (probes.length === 0) continue;

    const eslint = new ESLint({ cwd: join(repoRoot, root) });
    for (const probe of probes) {
      const relative = root === "" ? probe : probe.slice(root.length + 1);
      await foldFile(eslint, relative, loudest);
    }
  }
  return loudest;
}

/**
 * Asks one named config what it would make of files it may not govern.
 *
 * `loudestSeverities` lets ESLint pick each file's own config, which is what
 * a real run does. This asks the opposite question — what would THIS config
 * say about these files — which is the only way to catch a config claiming
 * files it never reaches. Both questions go to ESLint's own matcher, so every
 * glob spelling is covered, including the blocks that arrive by spreading an
 * imported config and so appear nowhere in the file's own text.
 * @param repoRoot Absolute path of the repository root.
 * @param configFile Repo-relative path of the config to use for every file.
 * @param files Repo-relative files to ask about.
 * @returns For each rule name, the loudest severity this config gives it.
 * @throws {Error} When ESLint cannot read the config or calculate a config.
 */
export async function severitiesUnderConfig(
  repoRoot: string,
  configFile: string,
  files: readonly string[],
): Promise<Map<string, Severity>> {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: join(repoRoot, configFile),
  });
  const loudest = new Map<string, Severity>();
  for (const file of files) {
    await foldFile(eslint, file, loudest);
  }
  return loudest;
}

/**
 * Names the directories holding an ESLint config.
 * @param files Every repo-relative path the repository consists of.
 * @returns Repo-relative directories, `""` for the repository root.
 */
export function configDirectories(files: readonly string[]): string[] {
  return files
    .filter((file) => CONFIG_FILE.test(file))
    .map((file) => (file.includes("/") ? dirname(file) : ""));
}
