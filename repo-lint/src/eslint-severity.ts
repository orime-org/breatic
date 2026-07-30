// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { ESLint } from "eslint";
import { dirname, join } from "node:path";

/** The severity a rule ends up with, normalised across ESLint's two spellings. */
export type Severity = "off" | "warn" | "error";

/** Config files ESLint reads, in every extension flat config allows. */
export const CONFIG_FILE = /(^|\/)eslint\.config\.(m?[jt]s|cjs)$/;

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
  const rank: Record<Severity, number> = { off: 0, warn: 1, error: 2 };
  const loudest = new Map<string, Severity>();

  const roots = [...configDirs];

  for (const root of roots) {
    const owned = files.filter((file) =>
      root === "" ? true : file.startsWith(`${root}/`),
    );
    // Attribution happens here, and only here: a file under a deeper config
    // directory belongs to that directory, so it is dropped from this one.
    // ESLint started in packages/web never reads the root config, and asking
    // the root about a web file would answer with rules that do not govern it.
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
      // Undefined for a path the config ignores — measured against ESLint 10,
      // which answers that way rather than throwing. An ignored file has no
      // severities to contribute, and reading through the undefined threw a
      // TypeError naming neither the file nor this check.
      const config = await eslint.calculateConfigForFile(relative);
      if (config === undefined || config === null) continue;
      for (const [id, entry] of Object.entries(config.rules ?? {})) {
        const severity = severityOf(entry);
        const seen = loudest.get(id);
        if (seen === undefined || rank[severity] > rank[seen]) {
          loudest.set(id, severity);
        }
      }
    }
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
