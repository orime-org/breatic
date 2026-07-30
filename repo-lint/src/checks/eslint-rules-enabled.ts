// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { breaticPlugin } from "@breatic/eslint-rules";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import {
  configDirectories,
  loudestSeverities,
  type Severity,
} from "#repo-lint/eslint-severity";

/** The config ESLint reads for every package except web. */
const ROOT_CONFIG = "eslint.config.ts";

/** A `files` glob in a config, with its contents. */
const FILES_GLOB = /files:\s*\[([^\]]*)\]/g;

/**
 * A glob that would match a path inside the web package.
 *
 * Either spelling: the wildcard form, which reads as repo-wide, and the
 * outright naming, which reads as deliberate. Both govern nothing.
 */
const CLAIMS_WEB = /packages\/(\*|\{[^}]*\bweb\b[^}]*\}|web)\//;

/**
 * Reads a config, refusing rather than treating a missing one as empty.
 * @param context The check context.
 * @param path Repo-relative path to the config.
 * @returns The file's contents.
 * @throws {Error} When the config is not where this check expects it.
 */
function readConfig(context: CheckContext, path: string): string {
  if (!context.exists(path)) {
    throw new Error(
      `${path} is not there. This check answers "is every rule switched on somewhere", and a config it cannot read makes every rule look switched off — or, worse, makes the answer depend on which file happens to be missing.`,
    );
  }
  return context.read(path);
}

/**
 * Reports rules nothing enables, and root globs that cannot mean what they say.
 *
 * Separate from the check itself so the two questions can be asked of a
 * fixture rather than of this repository's own configs, which change.
 * @param context The check context.
 * @param registered Every rule name the plugin exports.
 * @param severities The severity each rule resolves to, as ESLint reports it.
 * @returns One finding per unenabled rule and per web-claiming root glob.
 * @throws {Error} When the root config file is missing.
 */
export function auditEslintWiring(
  context: CheckContext,
  registered: readonly string[],
  severities: ReadonlyMap<string, Severity>,
): Finding[] {
  const root = readConfig(context, ROOT_CONFIG);

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

  for (const [, globs] of root.matchAll(FILES_GLOB)) {
    if (!CLAIMS_WEB.test(globs ?? "")) continue;
    findings.push({
      file: ROOT_CONFIG,
      message: `the glob ${(globs ?? "").trim().replace(/\s+/g, " ")} matches paths in the web package, which this config cannot reach — ESLint started in packages/web reads that package's own config and never this file. Name the packages this file governs, and declare the rule in packages/web/eslint.config.mts as well if it should apply there.`,
    });
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
 * read for six packages and never for web, so a `packages/*` glob there reads
 * as repo-wide while governing nothing in the largest source tree in the
 * repository. Two rules were declared that way and enforced everywhere except
 * web, which is exactly the shape of failure that leaves no trace.
 */
export const eslintRulesEnabled = {
  name: "eslint-rules-enabled",
  description: "Every plugin rule is switched on by some config",
  async run(context: CheckContext): Promise<Finding[]> {
    const everything = context.files(() => true, "every file");
    // Tests included: test-file-location's whole subject is where a test
    // sits, so excluding tests would make the one rule that only ever matches
    // them look like it matches nothing.
    const sources = context.files(
      (path) => /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(path),
      "first-party source files",
    );
    const severities = await loudestSeverities(
      context.repoRoot,
      configDirectories(everything),
      sources,
    );
    return auditEslintWiring(
      context,
      Object.keys(breaticPlugin.rules ?? {}),
      severities,
    );
  },
} satisfies Check;
