// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
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
 * Matches the manifest of every package the workspace declares.
 *
 * Read from pnpm-workspace.yaml rather than restated. This check exists to
 * report a package nothing lints, and a hand-kept list of where packages live
 * fails in exactly that way: a package added outside it is not looked for,
 * so it is never reported as unlinted. Restating the list here would put the
 * check's own blind spot in the same shape as the defect it reports.
 * @param context The check context.
 * @returns A pattern over repo-relative manifest paths.
 * @throws {Error} When the workspace file is missing or declares no packages.
 */
function workspaceManifests(context: CheckContext): RegExp {
  if (!context.exists(WORKSPACE)) {
    throw new Error(
      `${WORKSPACE} is not there, so this check cannot know which packages the workspace has. Guessing would mean reporting clean for packages it never looked for.`,
    );
  }
  const lines = context.read(WORKSPACE).split("\n");
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (start === -1) break;
    const entry = /^\s+-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (entry?.[1] === undefined) break;
    globs.push(entry[1]);
  }
  if (globs.length === 0) {
    throw new Error(
      `${WORKSPACE} declares no packages, so this check would look at nothing and report clean.`,
    );
  }
  const alternatives = globs.map((glob) =>
    glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+"),
  );
  return new RegExp(`^(${alternatives.join("|")})/package\\.json$`);
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
    const declared = workspaceManifests(context);
    const manifests = context.files(
      (path) => declared.test(path),
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
      }
    }
    findings.push(...uncruisedPackages(context, manifests));
    return findings;
  },
} satisfies Check;

/**
 * Reports packages the import-graph linter is never pointed at.
 *
 * Its directories are arguments on one line rather than something derived,
 * so a package can join the workspace and never appear there. `packages/*`
 * covers the ones nested under it; anything at the repository root has to be
 * named, and the two that were added at the root were not.
 * @param context The check context.
 * @param manifests Every workspace package manifest, repo-relative.
 * @returns One finding per package outside the cruise arguments.
 */
function uncruisedPackages(
  context: CheckContext,
  manifests: readonly string[],
): Finding[] {
  const root = "package.json";
  if (!context.exists(root)) return [];
  const script =
    (JSON.parse(context.read(root)) as Manifest).scripts?.[
      "lint:dependency-cruiser"
    ] ?? "";

  const findings: Finding[] = [];
  for (const file of manifests) {
    const directory = file.slice(0, -"/package.json".length);
    if (directory.startsWith("packages/")) continue;
    if (script.includes(`${directory}/src`)) continue;
    findings.push({
      file: root,
      message: `\`lint:dependency-cruiser\` never reads ${directory}/src, so no import rule applies there. A package outside the cruise arguments looks exactly like a package whose imports are all legal.`,
    });
  }
  return findings;
}
