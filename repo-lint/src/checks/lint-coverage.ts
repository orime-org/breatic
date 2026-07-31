// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { minimatch } from "minimatch";
import { parse } from "yaml";
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** A package manifest, as far as this check reads one. */
interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly scripts?: Record<string, string>;
}

/** Where the workspace is defined, which is the only place it is defined. */
const WORKSPACE = "pnpm-workspace.yaml";

/**
 * Decides whether a manifest belongs to a package the workspace declares.
 *
 * pnpm's own documented example for this file is `packages/**` alongside
 * `!**\/test/**`, and both spellings defeated the converter that used to
 * translate these globs into a regular expression by hand: `*` became one
 * path segment, so `**` looked exactly one directory deep, and `!` became a
 * literal that matched nothing. A package that is never looked for is never
 * reported as unlinted, which is this check's whole subject — so the globs go
 * to a glob matcher, and the exclusion form pnpm documents is honoured as an
 * exclusion.
 * @param globs The workspace's `packages` entries, in order.
 * @returns A predicate over repo-relative manifest paths.
 */
function declaredBy(globs: readonly string[]): (path: string) => boolean {
  const included = globs.filter((glob) => !glob.startsWith("!"));
  const excluded = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => glob.slice(1));
  return (path: string): boolean => {
    if (!path.endsWith("/package.json")) return false;
    const directory = path.slice(0, -"/package.json".length);
    if (excluded.some((glob) => minimatch(directory, glob))) return false;
    return included.some((glob) => minimatch(directory, glob));
  };
}

/**
 * Whether a lint script hands ESLint the whole package.
 *
 * Asked as "is `.` among the words", not by working out which words are paths
 * and which are flag values — that is shell parsing, and every attempt at it
 * in this suite has been a source of quiet wrong answers. `.` is the only
 * argument that means the package, so its presence is the question, and flags
 * around it change nothing.
 * @param script The package's `lint` script.
 * @returns True when ESLint is pointed at the package rather than into it.
 */
function coversThePackage(script: string): boolean {
  return script
    .split(/\s+/)
    .some((word) => word.replace(/^['"]|['"]$/g, "") === ".");
}

/**
 * Reads the package globs the workspace declares.
 *
 * Read from pnpm-workspace.yaml rather than restated. This check exists to
 * report a package nothing lints, and a hand-kept list of where packages live
 * fails in exactly that way: a package added outside it is not looked for,
 * so it is never reported as unlinted. Restating the list here would put the
 * check's own blind spot in the same shape as the defect it reports.
 * @param context The check context.
 * @returns The `packages` entries, in the order the file lists them.
 * @throws {Error} When the workspace file is missing or declares no packages.
 */
function workspaceGlobs(context: CheckContext): string[] {
  if (!context.exists(WORKSPACE)) {
    throw new Error(
      `${WORKSPACE} is not there, so this check cannot know which packages the workspace has. Guessing would mean reporting clean for packages it never looked for.`,
    );
  }
  // Parsed, not pattern-matched. A hand-written reader stopped at the first
  // line that was not an entry, so a comment or a blank line inside the list
  // silently truncated it — and a package that is never looked for is never
  // reported as unlinted, which is this check's whole subject. The repository
  // already depends on a YAML parser for its own config files; there was never
  // a reason for this one to be different.
  const parsed: unknown = parse(context.read(WORKSPACE));
  const declared =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { packages?: unknown }).packages
      : undefined;
  const globs = Array.isArray(declared)
    ? declared.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (globs.length === 0) {
    throw new Error(
      `${WORKSPACE} declares no packages, so this check would look at nothing and report clean.`,
    );
  }
  return globs;
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
