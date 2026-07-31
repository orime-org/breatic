// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { resolve } from "node:path";
import { minimatch } from "minimatch";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { declaredBy, workspaceGlobs } from "#repo-lint/workspace";

/** A package manifest, as far as this check reads one. */
interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly scripts?: Record<string, string>;
}

/**
 * An arbitrary fixed directory to resolve arguments against.
 *
 * Fixed rather than the working directory so the answer is about the argument
 * and not about where the process happens to have been started.
 */
const BASE = "/package";

/**
 * Whether a lint script hands ESLint the whole package.
 *
 * Every word is resolved as a path against a fixed base, and a word that
 * resolves back to the base is the package itself. No word is worked out to
 * be a path or a flag value first — that is shell parsing, and every attempt
 * at it in this suite has been a source of quiet wrong answers; a flag simply
 * resolves to somewhere that is not the base.
 *
 * Resolution rather than comparison against the character `.`, because `./`
 * and `.//` and a quoted `'./'` all name the same directory, and each was
 * read as a narrowing — with a message telling the reader to point ESLint at
 * what it was already pointed at. Empty words are dropped first: they come
 * from a leading or trailing space in the script and would resolve to the
 * base, reading as coverage where nothing was said at all.
 * @param script The package's `lint` script.
 * @returns True when ESLint is pointed at the package rather than into it.
 */
function coversThePackage(script: string): boolean {
  return script
    .split(/\s+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ""))
    .filter((word) => word.length > 0)
    .some((word) => resolve(BASE, word) === BASE);
}

/**
 * Every workspace package runs the linter.
 *
 * The rules live in one shared plugin, but reaching a file is per package:
 * the linter runs once per `lint` script, so a package without one is a
 * package none of the rules apply to. Nothing else notices. The repository
 * would still build, still typecheck, still pass every other check, and
 * the mandated rules — licence headers, no relative imports, no logger in
 * a library, no environment access in a library — would simply stop
 * applying there.
 *
 * That is the shape of failure worth guarding: not a rule that reports the
 * wrong thing, which someone sees, but a rule that reports nothing, which
 * looks exactly like passing. So the opt-in is made non-deletable rather
 * than left to memory.
 *
 * The import-graph rules are a second linter with its own scope, handed
 * directories by hand on one line of the root manifest, so the same failure
 * has a second home: two packages added to the workspace sat outside that
 * line and had no import rule applied to them at all. Both halves are
 * checked here because they are one question — is this package linted — asked
 * of two tools.
 *
 * Which paths within a package each tool should read is a narrower question
 * this check does not answer; it requires only that the package is reached.
 */
export const lintCoverage = {
  name: "lint-coverage",
  description: "Every workspace package runs the linter",
  run(context: CheckContext): Finding[] {
    const declared = declaredBy(workspaceGlobs(context));
    const manifests = context.files(
      declared,
      "workspace package manifests",
    );

    const findings: Finding[] = [];
    for (const file of manifests) {
      const manifest = JSON.parse(context.read(file)) as Manifest;
      const script = manifest.scripts?.["lint"];
      if (script === undefined) {
        findings.push({
          file,
          message:
            "this package has no `lint` script, so none of the shared rules run against it. A package the linter never visits looks exactly like a package with no violations.",
        });
        continue;
      }
      if (!/\beslint\b/.test(script)) {
        findings.push({
          file,
          message: `its \`lint\` script is \`${script}\`, which does not run eslint — the shared rules are enforced by eslint alone, so nothing enforces them here.`,
        });
        continue;
      }
      if (!coversThePackage(script)) {
        findings.push({
          file,
          message: `its \`lint\` script is \`${script}\`, which points eslint at part of the package rather than at \`.\`. Whatever sits outside that path is read by no rule at all — which is how every config file at every package root came to be linted by nothing, with this check reporting clean because the package did run the linter.`,
        });
      }
    }
    findings.push(...uncruisedPackages(context, manifests));
    return findings;
  },
} satisfies Check;

/** The root manifest, which is where the import-graph linter's scope lives. */
const ROOT_MANIFEST = "package.json";

/** The script whose arguments decide what the import-graph linter reads. */
const CRUISE_SCRIPT = "lint:dependency-cruiser";

/**
 * Reads the cruise arguments, refusing rather than treating absence as clean.
 * @param context The check context.
 * @returns The script's whitespace-separated words.
 * @throws {Error} When the root manifest or the cruise script is not there.
 */
function cruiseWords(context: CheckContext): string[] {
  if (!context.exists(ROOT_MANIFEST)) {
    throw new Error(
      `${ROOT_MANIFEST} is not there, so this check cannot know what the import-graph linter reads. Skipping that half would report clean for packages it never looked at.`,
    );
  }
  const script = (JSON.parse(context.read(ROOT_MANIFEST)) as Manifest).scripts?.[
    CRUISE_SCRIPT
  ];
  if (script === undefined) {
    throw new Error(
      `the root manifest has no \`${CRUISE_SCRIPT}\` script, so no import rule applies to any package. Reported one package at a time this would read as a list of packages to add to the arguments, when the arguments are gone.`,
    );
  }
  return script.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * Reports packages the import-graph linter is never pointed at.
 *
 * Its directories are arguments on one line rather than something derived, so
 * a package can join the workspace and never appear there. Every word of the
 * script is tried as a glob against the package's `src`, which is what the
 * shell does with those words before the linter ever sees them; the flags and
 * the command name are tried too and match nothing, so no word needs to be
 * recognised as a path.
 *
 * Asked as a glob, not as a substring, and of every package rather than only
 * the ones outside `packages/`. Both shortcuts answered a question next to the
 * real one: a hard-coded `packages/` skip reports clean for a package under it
 * however the arguments are narrowed, and a substring test is satisfied by any
 * longer path that happens to end in the package's own.
 * @param context The check context.
 * @param manifests Every workspace package manifest, repo-relative.
 * @returns One finding per package outside the cruise arguments.
 * @throws {Error} When the cruise arguments cannot be read.
 */
function uncruisedPackages(
  context: CheckContext,
  manifests: readonly string[],
): Finding[] {
  const words = cruiseWords(context);

  const findings: Finding[] = [];
  for (const file of manifests) {
    const source = `${file.slice(0, -"/package.json".length)}/src`;
    if (words.some((word) => minimatch(source, word))) continue;
    findings.push({
      file: ROOT_MANIFEST,
      message: `\`${CRUISE_SCRIPT}\` never reads ${source}, so no import rule applies there. A package outside the cruise arguments looks exactly like a package whose imports are all legal.`,
    });
  }
  return findings;
}
