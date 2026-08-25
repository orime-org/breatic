// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { breaticPlugin } from "@breatic/eslint-rules";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import {
  configDirectories,
  loudestSeverities,
  severitiesUnderConfig,
  type Severity,
} from "#repo-lint/eslint-severity";

/** The config ESLint reads for every package except web. */
const ROOT_CONFIG = "eslint.config.ts";

/** Extensions ESLint is pointed at anywhere in this repository. */
const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

/**
 * Directories the root config cannot govern, derived rather than named.
 *
 * A directory carrying its own flat config is the one ESLint resolves for a
 * file inside it, so nothing the root config says about that file applies.
 * Today `packages/web` is the only one — and naming it here is what would
 * make the second such package invisible to this check on the day it appears,
 * with the list needed to notice already computed one line away.
 * @param files Every repo-relative path the repository consists of.
 * @returns Repo-relative directories, root excluded.
 */
export function packagesOutOfRootReach(files: readonly string[]): string[] {
  return configDirectories(files).filter((directory) => directory !== "");
}

/**
 * Refuses to run when the root config is not where this check expects it.
 * @param context The check context.
 * @throws {Error} When the config is missing.
 */
function requireRootConfig(context: CheckContext): void {
  if (!context.exists(ROOT_CONFIG)) {
    throw new Error(
      `${ROOT_CONFIG} is not there. This check answers "is every rule switched on somewhere", and a config it cannot read makes every rule look switched off — or, worse, makes the answer depend on which file happens to be missing.`,
    );
  }
}

/**
 * Reports rules nothing enables, and root globs that cannot mean what they say.
 *
 * Separate from the check itself so the two questions can be asked of a
 * fixture rather than of this repository's own configs, which change.
 * @param context The check context.
 * @param registered Every rule name the plugin exports.
 * @param severities The severity each rule resolves to, as ESLint reports it.
 * @param rootOverOthers What the root config alone makes of files in packages
 *   that carry their own config, keyed by that package's directory.
 * @returns One finding per unenabled rule and per rule the root claims for a
 *   package it cannot govern.
 * @throws {Error} When the root config file is missing.
 */
export function auditEslintWiring(
  context: CheckContext,
  registered: readonly string[],
  severities: ReadonlyMap<string, Severity>,
  rootOverOthers: ReadonlyMap<string, ReadonlyMap<string, Severity>>,
): Finding[] {
  requireRootConfig(context);

  const findings: Finding[] = [];
  for (const name of registered) {
    const reached = severities.get(`breatic/${name}`);
    if (reached === "error") continue;
    findings.push({
      file: ROOT_CONFIG,
      message:
        reached === undefined
          ? `"breatic/${name}" is exported by the plugin and reaches no file, so it never runs. A rule with a file, an export and a passing unit test still reports nothing until a config puts it in front of some source, and reporting nothing is indistinguishable from finding nothing.`
          : reached === "off"
            ? `"breatic/${name}" reaches source but is switched off there, so it never reports. Deleting the line and setting it to "off" produce the same silence; this check reads the configuration ESLint actually resolves, so both are visible here.`
            : `"breatic/${name}" reaches source only as a warning, which does not fail the build. An invariant that only warns is a suggestion, and this repository already decided these are not suggestions.`,
    });
  }

  for (const [directory, reached] of rootOverOthers) {
    for (const [id, severity] of reached) {
      if (severity === "off" || !id.startsWith("breatic/")) continue;
      findings.push({
        file: ROOT_CONFIG,
        message: `"${id}" is declared here for files in ${directory}, which this config never governs — that directory carries a config of its own, and that is the one ESLint resolves for a file inside it. The declaration reads as covering ${directory} and covers nothing there. Name the packages this file can reach, and declare the rule in ${directory}'s own config as well if it should apply there.`,
      });
    }
  }

  return findings;
}

/**
 * Every rule the plugin exports is switched on, and no glob claims what it
 * cannot govern.
 *
 * Two guards sit either side of this one and neither covers it: lint-coverage
 * asserts each package runs the linter, and the plugin's own registry test
 * asserts each rule file is exported. Between "the linter runs here" and "the
 * rule exists" is the question of whether any config names the rule — and
 * deleting one line answered it wrongly with every check, every test and the
 * whole build still green.
 *
 * The second half guards the way that line goes missing. The root config is
 * read for six packages and never for the one that carries a config of its
 * own, so a `packages/*` glob there reads as repo-wide while governing
 * nothing in the largest source tree in the repository. Two rules were
 * declared that way and enforced everywhere except web, which is exactly the
 * shape of failure that leaves no trace.
 *
 * That half asks ESLint rather than reading the config's text. A scan for
 * glob spellings has to know them all, and knew three: `packages/**`, a
 * repo-wide `**`, a block carrying no `files` key at all and — the one no
 * scan of this file could ever see — a block spread in from an imported
 * config all walked past it. Loading the config and asking what it makes of
 * a real file leaves nothing to enumerate.
 *
 * Which packages to ask about is derived, not named. `packages/web` is the
 * only one today, and writing that down is what would leave the second such
 * package unasked on the day it appears.
 */
export const eslintRulesEnabled = {
  name: "eslint-rules-enabled",
  description: "Every plugin rule is switched on by some config",
  async run(context: CheckContext): Promise<Finding[]> {
    requireRootConfig(context);
    const everything = context.files(() => true, "every file");
    // Tests included: test-file-location's whole subject is where a test
    // sits, so excluding tests would make the one rule that only ever matches
    // them look like it matches nothing.
    const sources = context.files(
      (path) => SOURCE.test(path),
      "first-party source files",
    );
    const severities = await loudestSeverities(
      context.repoRoot,
      configDirectories(everything),
      sources,
    );
    // Every source file under each of them, for the same reason the probes
    // above are every file: a glob narrow enough to name one file is still a
    // glob claiming a package the root config cannot reach.
    const rootOverOthers = new Map<string, Map<string, Severity>>();
    for (const directory of packagesOutOfRootReach(everything)) {
      const owned = context.files(
        (path) => path.startsWith(`${directory}/`) && SOURCE.test(path),
        `source files in ${directory}`,
      );
      rootOverOthers.set(
        directory,
        await severitiesUnderConfig(context.repoRoot, ROOT_CONFIG, owned),
      );
    }
    return auditEslintWiring(
      context,
      Object.keys(breaticPlugin.rules ?? {}),
      severities,
      rootOverOthers,
    );
  },
} satisfies Check;
